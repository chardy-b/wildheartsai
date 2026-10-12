import { requireSession } from "@/lib/session";
import { HealthChat } from "./HealthChat";
import "./chat.css";

export default async function ChatPage() {
  await requireSession();
  return <section className="app-page chat-page" aria-label="Health chat">
    {process.env.CHAT_ENABLED === "1" ? <HealthChat /> : <p role="status">Chat is being prepared and is not available yet.</p>}
  </section>;
}
