import { createRoot } from "react-dom/client"
import App from "./App.tsx"

// Force SW update — pastiin user selalu dapat bundle terbaru (ga cache lama)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    for (const reg of regs) reg.update();
  });
}

createRoot(document.getElementById("root")!).render(
  <App />
)