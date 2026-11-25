/* Genera public/js/config.js desde .env (solo URL y anon key, seguros para el navegador). */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const destino = path.resolve("public/js/config.js");
fs.mkdirSync(path.dirname(destino), { recursive: true });

const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const anon = String(process.env.SUPABASE_ANON_KEY || "").trim();

if (!url || !anon) throw new Error("Faltan SUPABASE_URL o SUPABASE_ANON_KEY en .env");

const contenido = `/* Generado por scripts/generar-config.mjs — no editar a mano. */
window.LEVAPAN_CONFIG = Object.freeze({
  supabaseUrl: ${JSON.stringify(url)},
  supabaseAnonKey: ${JSON.stringify(anon)},
  bucket: "boveda-ti",
  palette: { vino: "#8B1E24", blanco: "#F6F4F2", bronce: "#A27D54", crema: "#F7E1C7" },
});
`;

fs.writeFileSync(destino, contenido, "utf8");
console.log("public/js/config.js generado (" + contenido.length + " bytes)");
