import { requireSession } from "@/lib/session";
import { isDemoUser } from "@/lib/demo/access";
import { isDemoIdentity } from "@/lib/demo/identity";
import { HealthChat } from "./HealthChat";
import "./chat.css";

export default async function ChatPage({ searchParams }: PageProps<"/app/chat">) {
  const session = await requireSession();
  const params = await searchParams;
  const initialDraft = isDemoUser(session.user.id) && typeof params.prompt === "string" ? params.prompt.slice(0, 2000) : "";
  return <section className="app-page chat-page" aria-label="Health chat">
    {process.env.CHAT_ENABLED === "1" ? <HealthChat key={session.user.id} initialDraft={initialDraft} workspace={isDemoIdentity(session.user.id) ? "demo" : "personal"} /> : <p role="status">Chat is being prepared and is not available yet.</p>}
  </section>;
}
