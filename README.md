# Rebaño de Incógnito (online)

Juego de cartas multijugador: alpacas disfrazadas, depredadores andinos y salas de hasta 12 jugadores y hasta 8 espectadores.
El servidor guarda la partida y cada jugador ve solo su mano. Los asientos vacíos se pueden llenar con bots.

## Probarlo en tu computadora

Necesitas Node.js 18 o superior.

```bash
npm install
npm start
```

Abre http://localhost:3000. Para probar con varios jugadores, abre otra ventana en modo incógnito
(cada ventana normal comparte la misma identidad) y únete con el código de la sala.

## Publicarlo gratis en Render

1. Sube esta carpeta a un repositorio de GitHub (sin `node_modules`, ya está en `.gitignore`).
2. Entra a https://render.com, inicia sesión con GitHub y elige **New → Web Service**.
3. Selecciona el repositorio y configura:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Pulsa **Create Web Service**. En unos minutos tendrás una dirección tipo
   `https://rebano-de-incognito.onrender.com`. Compártela con tus amigos.

En el plan gratis, el servidor se duerme tras 15 minutos sin visitas: la primera carga después
de eso tarda alrededor de un minuto. Si se reinicia, las partidas en curso se pierden.

## Cómo se juega online

- Uno crea la sala y comparte el código de 4 letras o el enlace.
- El anfitrión agrega bots, elige partida corta y pulsa **Empezar partida** (mínimo 2 jugadores, máximo 12).
- Cada turno dura 35 segundos: cada carta de acción suma 10 segundos y cambiar, comprar, pagar o formar el comodín suman 5; si se acaba el tiempo, el juego roba por ti.
- Si alguien se desconecta, puede volver a entrar a la misma sala desde el mismo navegador.
- Al terminar, el anfitrión puede pedir revancha o volver a la sala.
- Hay chat en la sala de espera y en la partida, con reacciones rápidas.

Rebaños para ganar: 5 con 2–3 jugadores, 4 con 4, 3 con 5–12 (uno menos en partida corta).

## Estructura

- `server.js`: servidor web y salas (Express + Socket.IO).
- `src/engine.js`: reglas, bots y cadenas de ¡Buen intento! (el servidor es la autoridad).
- `src/data.js`: cartas y número de rebaños por jugadores.
- `public/`: la página del juego e ilustraciones.
