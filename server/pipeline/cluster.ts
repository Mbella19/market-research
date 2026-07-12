import { all, run, transaction } from "../db.ts";
import { codexJson } from "../ai/codex.ts";
import { clusterRefinePrompt, type ClusterCandidateInput } from "../ai/prompts.ts";
import { ZClusterRefine, JClusterRefine } from "../ai/schemas.ts";
import { tokenize } from "../lib/text.ts";
import type { AppSettings } from "../settings.ts";

/**
 * Crude suffix stemmer for clustering vectors only (never displayed):
 * invoice/invoices/invoicing → invoic, chase/chasing → chas.
 * Short statements need this or TF-IDF treats them as disjoint vocabularies.
 */
function stem(t: string): string {
  let s = t;
  if (s.length > 3) {
    if (/ies$/.test(s)) s = s.slice(0, -3) + "y";
    else if (/ses$/.test(s)) s = s.slice(0, -2);
    else if (/s$/.test(s) && !/ss$/.test(s)) s = s.slice(0, -1);
  }
  if (s.length > 5) s = s.replace(/(ing|ed)$/, "");
  if (s.length > 4) s = s.replace(/e$/, "");
  return s;
}

function stemTerms(text: string): string[] {
  return tokenize(text).map(stem);
}

interface ProblemRow {
  id: number;
  statement: string;
  category: string | null;
  persona: string | null;
  engagement: number;
}

type Vec = Map<string, number>;

function cosine(a: Vec, aNorm: number, b: Vec, bNorm: number): number {
  if (aNorm === 0 || bNorm === 0) return 0;
  // iterate over the smaller vector
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const bw = big.get(t);
    if (bw) dot += w * bw;
  }
  return dot / (aNorm * bNorm);
}

function norm(v: Vec): number {
  let s = 0;
  for (const w of v.values()) s += w * w;
  return Math.sqrt(s);
}

interface Candidate {
  members: number[]; // indexes into problems array
  centroid: Vec;
  centroidNorm: number;
  engagement: number;
}

function addToCentroid(c: Candidate, v: Vec): void {
  for (const [t, w] of v) c.centroid.set(t, (c.centroid.get(t) ?? 0) + w);
  c.centroidNorm = norm(c.centroid);
}

const JOIN_THRESHOLD = 0.28;
const MERGE_THRESHOLD = 0.42;
const AI_CANDIDATE_BATCH = 40;

export async function clusterProblems(
  scanId: number,
  topic: string | null,
  settings: AppSettings,
  signal: AbortSignal | undefined,
  log: (msg: string, type?: "log" | "warn") => void
): Promise<{ clusters: number; engine: "ai" | "heuristic" | "mixed"; clusteredProblems: number; unclusteredProblems: number }> {
  const problems = all<ProblemRow>(
    `SELECT p.id, p.statement, p.category, p.persona, (i.score + i.comments) AS engagement
     FROM problems p JOIN items i ON i.id = p.item_id
     WHERE p.scan_id = ? ORDER BY engagement DESC`,
    scanId
  );
  if (problems.length === 0) return { clusters: 0, engine: "heuristic", clusteredProblems: 0, unclusteredProblems: 0 };

  // ---- TF-IDF vectors over stemmed statement + category unigrams ----
  const docsTerms = problems.map((p) => stemTerms(`${p.statement} ${p.category ?? ""}`));
  const df = new Map<string, number>();
  for (const terms of docsTerms) {
    for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = problems.length;
  const vectors: Vec[] = docsTerms.map((terms) => {
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v: Vec = new Map();
    for (const [t, f] of tf) {
      const idf = Math.log(1 + N / (df.get(t) ?? 1));
      v.set(t, (1 + Math.log(f)) * idf);
    }
    return v;
  });
  const norms = vectors.map(norm);

  // ---- greedy agglomerative pass (problems arrive sorted by engagement) ----
  const candidates: Candidate[] = [];
  for (let i = 0; i < problems.length; i++) {
    if (signal?.aborted) throw new Error("aborted");
    const v = vectors[i]!;
    const vN = norms[i]!;
    let best: Candidate | null = null;
    let bestSim = JOIN_THRESHOLD;
    for (const c of candidates) {
      const sim = cosine(v, vN, c.centroid, c.centroidNorm);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best) {
      best.members.push(i);
      best.engagement += problems[i]!.engagement;
      addToCentroid(best, v);
    } else {
      const c: Candidate = { members: [i], centroid: new Map(), centroidNorm: 0, engagement: problems[i]!.engagement };
      addToCentroid(c, v);
      candidates.push(c);
    }
  }

  // ---- merge similar candidates ----
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (!a) continue;
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (!b) continue;
      if (cosine(a.centroid, a.centroidNorm, b.centroid, b.centroidNorm) >= MERGE_THRESHOLD) {
        a.members.push(...b.members);
        a.engagement += b.engagement;
        for (const [t, w] of b.centroid) a.centroid.set(t, (a.centroid.get(t) ?? 0) + w);
        a.centroidNorm = norm(a.centroid);
        candidates[j] = undefined as unknown as Candidate;
      }
    }
  }
  // Keep singletons — the AI refine pass merges semantically-equal candidates
  // that lexical TF-IDF can't see. Only the low-engagement tail is cut when
  // we're over the prompt budget.
  const kept = candidates
    .filter((c): c is Candidate => Boolean(c))
    .sort((a, b) => b.members.length * 1000 + b.engagement - (a.members.length * 1000 + a.engagement));

  log(`local clustering: ${kept.length} candidate groups from ${problems.length} problems`);
  if (kept.length === 0) return { clusters: 0, engine: "heuristic", clusteredProblems: 0, unclusteredProblems: problems.length };

  const topTerms = (c: Candidate, n: number): string[] =>
    [...c.centroid.entries()]
      .filter(([t]) => !t.includes(" ")) // unigrams read better in names
      .sort((x, y) => y[1] - x[1])
      .slice(0, n)
      .map(([t]) => t);

  const heuristicMeta = (c: Candidate) => {
    const cats = new Map<string, number>();
    const personas = new Map<string, number>();
    for (const idx of c.members) {
      const p = problems[idx]!;
      if (p.category) cats.set(p.category, (cats.get(p.category) ?? 0) + 1);
      if (p.persona && p.persona !== "unknown") personas.set(p.persona, (personas.get(p.persona) ?? 0) + 1);
    }
    const top = (m: Map<string, number>, fallback: string) =>
      [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
    return { category: top(cats, "general"), persona: top(personas, "unknown") };
  };

  // ---- AI refinement: merge/name/summarize ----
  interface FinalCluster {
    memberProblemIds: number[];
    name: string;
    summary: string;
    category: string;
    persona: string;
    engine: "ai" | "heuristic";
  }
  const finals: FinalCluster[] = [];
  const quarantinedCandidates = new Set<number>();
  let engine: "ai" | "heuristic" | "mixed" = "heuristic";

  if (settings.ai.enabled) {
    const consumed = new Set<number>();
    let aiFinals = 0;
    let aiFailed = false;
    for (let start = 0; start < kept.length; start += AI_CANDIDATE_BATCH) {
      if (signal?.aborted) throw new Error("aborted");
      const indexes = Array.from(
        { length: Math.min(AI_CANDIDATE_BATCH, kept.length - start) },
        (_, offset) => start + offset
      );
      const payload: ClusterCandidateInput[] = indexes.map((idx) => ({
        id: idx,
        size: kept[idx]!.members.length,
        samples: kept[idx]!.members.slice(0, 8).map((problemIndex) => problems[problemIndex]!.statement.slice(0, 220)),
      }));
      try {
        const { data } = await codexJson(
          {
            task: `cluster-refine(${start + 1}-${start + payload.length})`,
            prompt: clusterRefinePrompt(payload, topic),
            effort: settings.ai.efforts.cluster,
            schema: JClusterRefine,
            timeoutMs: 20 * 60_000,
            signal,
          },
          ZClusterRefine
        );
        for (const out of data.clusters) {
          const localSeen = new Set<number>();
          const memberCandidates = out.memberIds.filter((id) => {
            if (!indexes.includes(id) || consumed.has(id) || localSeen.has(id)) return false;
            localSeen.add(id);
            return true;
          });
          if (memberCandidates.length === 0) continue;
          for (const id of memberCandidates) consumed.add(id);
          const problemIdxs = memberCandidates.flatMap((id) => kept[id]!.members);
          if (!out.coherent) {
            for (const id of memberCandidates) quarantinedCandidates.add(id);
            log(`discarded incoherent AI grouping containing ${problemIdxs.length} problems`, "warn");
            continue;
          }
          const meta = heuristicMeta(kept[memberCandidates[0]!]!);
          finals.push({
            memberProblemIds: [...new Set(problemIdxs.map((i) => problems[i]!.id))],
            name: out.name.trim() || topTerms(kept[memberCandidates[0]!]!, 3).join(" · "),
            summary: out.summary.trim(),
            category: out.category.trim().toLowerCase() || meta.category,
            persona: out.persona.trim() || meta.persona,
            engine: "ai",
          });
          aiFinals++;
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        aiFailed = true;
        log(
          `AI cluster refinement unavailable after candidate ${start} (${err instanceof Error ? err.message.slice(0, 160) : err}) — heuristic naming for the remainder`,
          "warn"
        );
        break;
      }
    }
    // Candidates omitted by AI or not attempted after a failure remain visible,
    // but candidates explicitly consumed as incoherent stay quarantined.
    kept.forEach((candidate, idx) => {
      if (consumed.has(idx)) return;
      const meta = heuristicMeta(candidate);
      finals.push({
        memberProblemIds: candidate.members.map((i) => problems[i]!.id),
        name: topTerms(candidate, 3).join(" · ") || "unnamed cluster",
        summary: "",
        category: meta.category,
        persona: meta.persona,
        engine: "heuristic",
      });
    });
    engine = aiFinals > 0 && (aiFailed || finals.some((final) => final.engine === "heuristic")) ? "mixed" : aiFinals > 0 ? "ai" : "heuristic";
    log(`AI refinement produced ${aiFinals} coherent clusters from ${kept.length} candidates`);
  }

  if (finals.length === 0) {
    for (const [idx, c] of kept.entries()) {
      if (quarantinedCandidates.has(idx)) continue;
      const meta = heuristicMeta(c);
      finals.push({
        memberProblemIds: c.members.map((i) => problems[i]!.id),
        name: topTerms(c, 3).join(" · ") || "unnamed cluster",
        summary: "",
        category: meta.category,
        persona: meta.persona,
        engine: "heuristic",
      });
    }
  }

  // Preserve every coherent problem assignment. Singleton clusters stay below
  // the author/platform gate, but silently discarding them made coverage look
  // better than it was and prevented later inspection/reclustering.
  const persisted = finals.filter((cluster) => cluster.memberProblemIds.length > 0);

  // ---- persist atomically ----
  transaction(() => {
    for (const fc of persisted) {
      const { lastId } = run(
        `INSERT INTO clusters (scan_id, name, summary, category, persona, engine) VALUES (?, ?, ?, ?, ?, ?)`,
        scanId,
        fc.name.slice(0, 120),
        fc.summary.slice(0, 800),
        fc.category.slice(0, 60),
        fc.persona.slice(0, 120),
        fc.engine
      );
      for (const pid of fc.memberProblemIds) {
        run("INSERT OR IGNORE INTO cluster_problems (cluster_id, problem_id) VALUES (?, ?)", lastId, pid);
      }
    }
  });

  const clusteredProblems = new Set(persisted.flatMap((cluster) => cluster.memberProblemIds)).size;
  log(`cluster coverage: ${clusteredProblems}/${problems.length} extracted problems assigned`);
  return {
    clusters: persisted.length,
    engine,
    clusteredProblems,
    unclusteredProblems: Math.max(0, problems.length - clusteredProblems),
  };
}
