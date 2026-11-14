import { router, usePathname } from "expo-router";
import { Empty } from "./StateView";

/** What a signed-in-only screen shows to a visitor. Sign-in returns them to this screen. */
export function SignInPrompt({ title, body }: { title: string; body: string }) {
  const path = usePathname();
  return (
    <Empty
      title={title}
      body={body}
      action="Sign in"
      onAction={() => router.push({ pathname: "/sign-in", params: { returnTo: path } })}
    />
  );
}
