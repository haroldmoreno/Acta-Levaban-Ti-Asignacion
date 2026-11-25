/* ============================================================
   registro.js | Alta de cuentas corporativas @levapan.com
   ------------------------------------------------------------
   Trabaja junto a js/auth.js: no modifica su lógica de sesión,
   solo añade la pestaña de registro y, tras crear el usuario,
   inicia sesión con el cliente Supabase ya configurado.
   ============================================================ */

(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const SOLO_CORPORATIVO = /^[A-Za-z0-9._%+-]+@levapan\.com$/i;

  function mostrarError(id, mensaje) {
    const elemento = byId(id);
    if (!elemento) return;
    elemento.textContent = mensaje || "";
    elemento.hidden = !mensaje;
  }

  function activarPestaña(cual) {
    const iniciar = byId("tabIniciarSesion");
    const crear = byId("tabCrearCuenta");
    const login = byId("loginForm");
    const registro = byId("registroForm");

    const esRegistro = cual === "registro";
    if (login) login.hidden = esRegistro;
    if (registro) registro.hidden = !esRegistro;
    if (iniciar) {
      iniciar.classList.toggle("activa", !esRegistro);
      iniciar.setAttribute("aria-selected", String(!esRegistro));
    }
    if (crear) {
      crear.classList.toggle("activa", esRegistro);
      crear.setAttribute("aria-selected", String(esRegistro));
    }
    mostrarError("loginError", "");
    mostrarError("registroError", "");
  }

  async function registrar(evento) {
    evento.preventDefault();

    const nombre = byId("registroNombre")?.value.trim() || "";
    const cedula = byId("registroCedula")?.value.trim() || "";
    const correo = byId("registroCorreo")?.value.trim().toLowerCase() || "";
    const clave = byId("registroClave")?.value || "";
    const boton = byId("registroBoton");

    mostrarError("registroError", "");
    if (!nombre || !cedula || !correo || !clave) {
      return mostrarError("registroError", "Completa todos los campos.");
    }
    if (!SOLO_CORPORATIVO.test(correo)) {
      return mostrarError(
        "registroError",
        "Solo se permiten correos corporativos que terminen en @levapan.com."
      );
    }
    if (clave.length < 6) {
      return mostrarError("registroError", "La contraseña debe tener al menos 6 caracteres.");
    }

    if (boton) {
      boton.disabled = true;
      boton.textContent = "Creando cuenta…";
    }

    try {
      const respuesta = await fetch("/api/registro-corporativo", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          nombre_completo: nombre,
          cedula,
          email: correo,
          password: clave,
        }),
      });
      const datos = await respuesta.json().catch(() => ({}));
      if (!respuesta.ok || !datos.ok) {
        throw new Error(datos.error || `No se pudo crear la cuenta (HTTP ${respuesta.status}).`);
      }

      const cliente = window.AuthLevapan?.cliente;
      if (!cliente) throw new Error("El cliente de Supabase aún no está listo. Inténtalo de nuevo.");

      const { error } = await cliente.auth.signInWithPassword({ email: correo, password: clave });
      if (error) throw new Error(error.message || "No se pudo iniciar sesión con la nueva cuenta.");

      byId("registroForm")?.reset();
    } catch (err) {
      mostrarError("registroError", err.message || "No se pudo completar el registro.");
    } finally {
      if (boton) {
        boton.disabled = false;
        boton.textContent = "Crear cuenta e ingresar";
      }
    }
  }

  function iniciar() {
    byId("tabIniciarSesion")?.addEventListener("click", () => activarPestaña("login"));
    byId("tabCrearCuenta")?.addEventListener("click", () => activarPestaña("registro"));
    byId("registroForm")?.addEventListener("submit", registrar);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar, { once: true });
  } else {
    iniciar();
  }
})();
