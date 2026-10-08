export function appUrl() {
  const origin = process.env.CHAT_TEST_WEB_ORIGIN;
  if (!origin) throw new Error("test_origin_required");
  return origin;
}
