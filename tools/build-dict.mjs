// Пересборка вшитых словарей. Запускать после обновления словарных пакетов:
//   npm i -D nspell dictionary-ru dictionary-en esbuild && node tools/build-dict.mjs
// Кладёт в ui.html два блока: движок проверки и сами словари, сжатые gzip и в base64.
// Лицензии: nspell MIT, dictionary-en MIT+BSD, dictionary-ru BSD-3-Clause — см. THIRD_PARTY_NOTICES.md
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const PKG = (n, f) => readFileSync(`node_modules/${n}/${f}`);
const b64 = (buf) => gzipSync(buf, { level: 9 }).toString("base64");
const dict = {
  ruAff: b64(PKG("dictionary-ru", "index.aff")),
  ruDic: b64(PKG("dictionary-ru", "index.dic")),
  enAff: b64(PKG("dictionary-en", "index.aff")),
  enDic: b64(PKG("dictionary-en", "index.dic")),
};
const engine = readFileSync("tools/nspell.bundle.js", "utf8");
const payload =
  `<script>${engine}</script>\n` +
  `<script>window.__BOOSTER_DICT=${JSON.stringify(JSON.stringify(dict))};</script>\n`;
const html = readFileSync("ui.html", "utf8");
const START = "<!-- dict:start -->", END = "<!-- dict:end -->";
const a = html.indexOf(START), b = html.indexOf(END);
if (a < 0 || b < 0) throw new Error("в ui.html нет маркеров dict:start / dict:end");
writeFileSync("ui.html", html.slice(0, a + START.length) + "\n" + payload + html.slice(b));
console.log("вшито, ui.html теперь", (readFileSync("ui.html").length / 1048576).toFixed(2), "МБ");
