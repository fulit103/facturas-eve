import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("No se encontró #root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
