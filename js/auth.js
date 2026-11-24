/* ============================================================
   auth.js | Supabase Auth · inicio de sesión corporativo
   ------------------------------------------------------------
   Expone window.AuthLevapan con:
     · cliente  : Supabase Client (persistencia localStorage)
     · sesion   : sesión vigente
     · perfil   : { nombre_completo, cedula, rol, email }
     · listo    : Promise que resuelve cuando hay perfil TI válido
     · token()  : access_token vigente
   Además inyecta el Authorization: Bearer en TODAS las llamadas
   same-origin a /api/, sin tocar el resto del código.
   ============================================================ */

(function () {
  "use strict";

  const Estado = {
    cliente: null,
    sesion: null,
    perfil: null,
    listo: null,
    configuracion: null,
  };

  const resolveListo = [];
  let resolvePerfil = null;
  let notificado = false;

  Estado.listo = new Promise((resolve) => resolveListo.push(resolve));

  function elementos() {
    return {
      app: document.getElementById("appContent"),
      login: document.getElementById("pantallaLogin"),
      formulario: document.getElementById("loginForm"),
      correo: document.getElementById("loginCorreo"),
      clave: document.getElementById("loginClave"),
      boton: document.getElementById("loginBoton"),
      error: document.getElementById("loginError"),
      nombre: document.getElementById("sesionNombre"),
      rol: document.getElementById("sesionRol"),
      salir: document.getElementById("btnCerrarSesion"),
    };
  }

  function mostrarError(mensaje) {
    const { error } = elementos();
    if (!error) return;
    error.textContent = mensaje || "";
    error.hidden = !mensaje;
  }

  function pintarSesion() {
    const { app, login, nombre, rol } = elementos();
    const activa = Boolean(Estado.perfil);

    if (app) app.hidden = !activa;
    if (login) login.hidden = activa;
    document.body.dataset.autenticado = activa ? "true" : "false";

    if (nombre) {
      nombre.textContent = activa
        ? Estado.perfil.nombre_completo || Estado.perfil.email || "Técnico TI"
        : "Sin sesión";
    }
    if (rol) {
      rol.textContent = activa
        ? Estado.perfil.rol === "admin"
          ? "Administrador TI"
          : "Técnico TI"
        : "";
    }
  }

  function notificarListo() {
    if (notificado) return;
    notificado = true;
    resolveListo.forEach((resolve) => resolve(Estado.perfil));
  }

  async function cargarPerfil() {
    const respuesta = await fetch("/api/perfil", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok || !datos.ok) {
      throw new Error(datos.error || `No se pudo cargar el perfil (HTTP ${respuesta.status}).`);
    }
    return datos;
  }

  /** Sincroniza la UI con el estado de Auth y resuelve la Promise `listo`. */
  async function aplicarSesion(sesion) {
    Estado.sesion = sesion;

    if (!sesion) {
      Estado.perfil = null;
      pintarSesion();
      return;
    }

    try {
      const perfil = await cargarPerfil();
      Estado.perfil = perfil;
      pintarSesion();
      if (resolvePerfil) resolvePerfil(perfil);
      notificarListo();
      window.dispatchEvent(new CustomEvent("auth-listo", { detail: perfil }));
    } catch (err) {
      Estado.perfil = null;
      pintarSesion();
      mostrarError(err.message);
      try {
        await Estado.cliente.auth.signOut();
      } catch {
        /* sesión ya expirada */
      }
    }
  }

  /** Intercepta fetch sólo para /api/ y añade el Bearer vigente. */
  function instalarInterceptor() {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async function (entrada, opciones = {}) {
      const url = String(
        typeof entrada === "string" || entrada instanceof URL ? entrada : entrada?.url || ""
      );

      if (url.startsWith("/api/") || url.includes(location.origin + "/api/")) {
        try {
          const { data } = await Estado.cliente.auth.getSession();
          const token = data?.session?.access_token;
          if (token) {
            const cabeceras = new Headers(opciones.headers || {});
            if (!cabeceras.has("Authorization")) {
              cabeceras.set("Authorization", `Bearer ${token}`);
            }
            opciones = { ...opciones, headers: cabeceras };
          }
        } catch (err) {
          console.warn("[AUTH] No se pudo adjuntar el token:", err);
        }
      }

      return fetchOriginal(entrada, opciones);
    };
  }

  async function inicializar() {
    const { formulario, correo, clave, boton, salir } = elementos();

    let configuracion;
    try {
      const respuesta = await fetch("/api/config-publica", { cache: "no-store" });
      configuracion = await respuesta.json();
    } catch (err) {
      mostrarError("No se pudo contactar el servidor. Revisa que esté encendido.");
      return;
    }

    if (!configuracion?.ok || !configuracion.supabaseUrl || !configuracion.supabaseAnonKey) {
      mostrarError(
        "Supabase no está configurado en el servidor. Revisa SUPABASE_URL y SUPABASE_ANON_KEY."
      );
      return;
    }
    Estado.configuracion = configuracion;

    if (!window.supabase?.createClient) {
      mostrarError(
        "No se pudo cargar la librería de Supabase en el navegador. Revisa tu conexión e inténtalo de nuevo."
      );
      return;
    }

    Estado.cliente = window.supabase.createClient(
      configuracion.supabaseUrl,
      configuracion.supabaseAnonKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: "acta-levapan-auth",
        },
      }
    );

    window.SupabaseLevapan = Estado.cliente;
    instalarInterceptor();

    const { data: inicial } = await Estado.cliente.auth.getSession();
    await aplicarSesion(inicial?.session || null);

    Estado.cliente.auth.onAuthStateChange(async (evento, sesion) => {
      if (evento === "INITIAL_SESSION") return;
      await aplicarSesion(sesion);
      if (sesion && evento === "SIGNED_IN") {
        window.dispatchEvent(new CustomEvent("auth-sesion-iniciada"));
      }
    });

    formulario?.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      mostrarError("");
      if (boton) {
        boton.disabled = true;
        boton.textContent = "Ingresando…";
      }
      try {
        const { data, error } = await Estado.cliente.auth.signInWithPassword({
          email: String(correo?.value || "").trim(),
          password: String(clave?.value || ""),
        });
        if (error) throw error;
        await aplicarSesion(data.session);
      } catch (err) {
        mostrarError(
          err?.message === "Invalid login credentials"
            ? "Correo o contraseña incorrectos."
            : err?.message || "No se pudo iniciar sesión."
        );
      } finally {
        if (boton) {
          boton.disabled = false;
          boton.textContent = "Ingresar";
        }
      }
    });

    salir?.addEventListener("click", async () => {
      try {
        await Estado.cliente.auth.signOut();
      } catch (err) {
        console.warn("[AUTH] Error al cerrar sesión:", err);
      }
      Estado.perfil = null;
      pintarSesion();
    });
  }

  window.AuthLevapan = {
    get cliente() {
      return Estado.cliente;
    },
    get sesion() {
      return Estado.sesion;
    },
    get perfil() {
      return Estado.perfil;
    },
    listo: Estado.listo,
    async token() {
      try {
        const { data } = await Estado.cliente?.auth.getSession();
        return data?.session?.access_token || "";
      } catch {
        return "";
      }
    },
    cerrarSesion() {
      const boton = document.getElementById("btnCerrarSesion");
      if (boton) boton.click();
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inicializar, { once: true });
  } else {
    inicializar();
  }
})();
