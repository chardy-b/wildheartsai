import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest/functions";

// Inngest calls this to run job steps; requests are verified with INNGEST_SIGNING_KEY.
export const { GET, POST, PUT } = serve({ client: inngest, functions });
