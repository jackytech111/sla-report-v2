import { createApp } from "./app.js";

const port = Number(process.env.PORT || 8080);

createApp().listen(port, "0.0.0.0", () => {
  console.log(`listening on http://0.0.0.0:${port}`);
});
