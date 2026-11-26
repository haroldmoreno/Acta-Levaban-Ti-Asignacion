import fs from "node:fs";
let s = fs.readFileSync("public/js/app.js", "utf8");

function quitar(desde, hasta) {
  const i = s.indexOf(desde);
  if (i === -1) return false;
  const j = s.indexOf(hasta, i);
  if (j === -1) return false;
  s = s.slice(0, i) + s.slice(j);
  return true;
}

console.log("bloque asistente:", quitar("  /* ---------------- Asistente TI ---------------- */", "  /* ---------------- Eventos ---------------- */"));
console.log("listeners chat:", quitar('    byId("btnAsistente").addEventListener("click"', '    let installPrompt = null;'));

s = s.replace(
  "  iniciar();\n})();",
  "  window.LevapanApp = { sb, ESTADO, cargarTodos, irAVista, abrirModalEquipo, mostrarFichaPlaca, abrirActa, generarYSubirActa, registrarHistorial, ORDEN_MAESTRO };\n\n  iniciar();\n})();"
);

fs.writeFileSync("public/js/app.js", s);
console.log("app.js preparado");
