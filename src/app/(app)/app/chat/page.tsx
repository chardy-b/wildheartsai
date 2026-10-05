import { requireSession } from "@/lib/session";
import { chatConfiguration } from "@/lib/chat-auth/ticket";
import { HealthChat } from "./HealthChat";
import "./chat.css";

export default async function ChatPage() {
  await requireSession();
  return <section className="app-page"><h1>Your health chat</h1><p className="lede">Ask about your saved records. Chats and helpful summaries are saved for your next visit.</p>
    {chatConfiguration() ? <HealthChat /> : <p role="status">Chat is being prepared and is not available yet.</p>}
  </section>;
}
