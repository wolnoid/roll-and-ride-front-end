import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { UserProvider } from "./contexts/UserContext.jsx";
import App from "./App.jsx";
import "./index.css";

const tree = (
  <BrowserRouter>
    <UserProvider>
      <App />
    </UserProvider>
  </BrowserRouter>
);

createRoot(document.getElementById("root")).render(
  import.meta.env.DEV ? tree : <StrictMode>{tree}</StrictMode>
);
