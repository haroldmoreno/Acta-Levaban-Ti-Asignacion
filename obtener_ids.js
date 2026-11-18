import "dotenv/config";
import { ConfidentialClientApplication } from "@azure/msal-node";
import axios from "axios";

const GRAPH_URL = "https://graph.microsoft.com/v1.0";
const SITE_URL_POR_DEFECTO =
  "https://colevapan.sharepoint.com/sites/Informatica_Tecnologia";
const LISTA_POR_DEFECTO = "Inventario 2020 PC";

/** Convierte una URL de SharePoint en la ruta /sites/{host}:{ruta} de Graph. */
function rutaGraphDelSitio(urlSitio) {
  const url = new URL(urlSitio);
  const host = url.hostname;
  const ruta = url.pathname.replace(/\/+$/, "") || "/";
  return `/sites/${host}:${ruta.startsWith("/") ? ruta : `/${ruta}`}`;
}

async function main() {
  const urlSitio = process.argv[2] || SITE_URL_POR_DEFECTO;
  const nombreLista = process.argv[3] || LISTA_POR_DEFECTO;

  const { TENANT_ID, CLIENT_ID, CLIENT_SECRET } = process.env;
  const faltantes = ["TENANT_ID", "CLIENT_ID", "CLIENT_SECRET"].filter(
    (nombre) => !String(process.env[nombre] ?? "").trim()
  );

  if (faltantes.length) {
    throw new Error(`Faltan variables en .env: ${faltantes.join(", ")}`);
  }

  const msal = new ConfidentialClientApplication({
    auth: {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    },
  });

  const resultado = await msal.acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });

  if (!resultado?.accessToken) {
    throw new Error("Microsoft Entra ID no devolvió un access token.");
  }

  const graph = axios.create({
    baseURL: GRAPH_URL,
    headers: {
      Authorization: `Bearer ${resultado.accessToken}`,
      Accept: "application/json",
    },
    timeout: 30000,
  });

  // 1. SITE_ID técnico del sitio de SharePoint.
  const sitio = await graph.get(rutaGraphDelSitio(urlSitio));

  const siteId = sitio.data?.id;
  if (!siteId) {
    throw new Error(`No se pudo obtener el SITE_ID de ${urlSitio}`);
  }

  // 2. LIST_ID de la lista indicada.
  const listas = await graph.get(`/sites/${siteId}/lists`, {
    params: { $select: "id,name,displayName,webUrl" },
  });

  const lista = (listas.data?.value ?? []).find(
    (item) =>
      item.displayName?.trim().toLowerCase() === nombreLista.toLowerCase() ||
      item.name?.trim().toLowerCase() === nombreLista.toLowerCase()
  );

  if (!lista?.id) {
    const disponibles = (listas.data?.value ?? [])
      .map((item) => item.displayName || item.name)
      .filter(Boolean)
      .join(" | ");
    throw new Error(
      `No se encontró la lista "${nombreLista}". Listas visibles: ${disponibles}`
    );
  }

  console.log("\n=== IDs obtenidos ===");
  console.log(`SITE_ID=${siteId}`);
  console.log(`LIST_ID=${lista.id}`);
  console.log(`Lista   : ${lista.displayName || lista.name}`);
  console.log(`Web     : ${lista.webUrl || "sin URL"}`);
  console.log("=====================\n");
}

try {
  await main();
} catch (error) {
  const detalle =
    error?.response?.data?.error?.message ||
    error?.response?.data?.error_description ||
    error?.message ||
    String(error);

  console.error("\n[ERROR] No se pudieron obtener los IDs.");
  console.error(detalle);

  if (error?.response?.status) {
    console.error(`HTTP ${error.response.status}`);
  }

  process.exitCode = 1;
}
