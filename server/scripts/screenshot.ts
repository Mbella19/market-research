/** UI smoke driver: screenshots key pages. Usage: npx tsx server/scripts/screenshot.ts <outdir> */
import { chromium } from "playwright-core";

const out = process.argv[2] ?? "data/tmp";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 })).newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const shots: [string, string, string][] = [
  ["dashboard", "http://127.0.0.1:5058/", "text=Find demand"],
  ["new-scan", "http://127.0.0.1:5058/new", "text=What should we investigate"],
  ["scan-live", "http://127.0.0.1:5058/scans/1", "text=Live log"],
  ["clusters", "http://127.0.0.1:5058/clusters?scan=1", "text=Problem clusters"],
  ["settings", "http://127.0.0.1:5058/settings", "text=AI engine"],
];
for (const [name, url, waitFor] of shots) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(waitFor, { timeout: 8000 });
  } catch {
    console.log(`WARN: selector missing on ${name}: ${waitFor}`);
  }
  await page.waitForTimeout(700); // let entrance animations settle
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  console.log(`shot: ${name}`);
}
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join("\n")}` : "no console errors");
await browser.close();
