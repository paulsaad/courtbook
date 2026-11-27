import Link from "next/link";
import { LegalPage, Pending, Section } from "@/components/legal";
import { COMMUNITY_RULES } from "@/lib/types";
import { LEGAL_STATUS } from "@/lib/legal";

/**
 * M5: the terms of use. Public (no sign-in). Every unmarked rule below is one the website, apps and database already
 * apply (evidence: docs/m5/privacy-evidence.md, section "Terms"); marked items (Pending) are not final.
 * The community rules are the ones players accept before their first chat message (src/lib/types.ts), shown verbatim.
 */
export const metadata = {
  title: "Terms of use — CourtBook",
  robots: LEGAL_STATUS === "draft" ? { index: false, follow: false } : undefined,
};

export default function TermsPage() {
  return (
    <LegalPage
      path="/terms"
      title="Terms of use"
      intro={<p>
        These terms apply when you use the CourtBook website or app. CourtBook is run by{" "}
        <Pending kind="decision">[operator: name of the company that runs CourtBook]</Pending>, of{" "}
        <Pending kind="decision">[postal address]</Pending>. <Pending kind="legal">By creating an account or using CourtBook,
        you agree to these terms.</Pending> How we handle your information is in the{" "}
        <Link href="/privacy" className="font-semibold text-turf">privacy policy</Link>.
      </p>}
    >
      <Section id="what" title="What CourtBook is">
        <p>CourtBook lets you book courts at sports clubs, find other players and organise games, and lets clubs run their
          calendar. <b>The courts and everything that happens at a club are the club’s.</b> A booking is an arrangement
          between you and the club. Lessons are arranged directly with the coach, using the contact the coach shows.</p>
        <p>CourtBook is available in Lebanon.</p>
      </Section>

      <Section id="account" title="Your account">
        <ul className="list-disc space-y-1 pl-5">
          <li>You must be 18 or over. We ask before you book, join a game or chat.</li>
          <li>Use your own name and true details. You are responsible for what is done with your account.</li>
          <li>You can delete your account at any time — see{" "}
            <Link href="/delete-account" className="font-semibold text-turf">Delete your account</Link>.</li>
        </ul>
      </Section>

      <Section id="bookings" title="Bookings and cancellation">
        <ul className="list-disc space-y-1 pl-5">
          <li>A booking is confirmed when CourtBook shows it as confirmed. A court cannot be booked twice for the same time.</li>
          <li>Each club sets its opening hours, how far ahead you can book, how short or long a booking can be, how many
            upcoming bookings you can hold there, and how long before the start you can cancel free of charge (shown with
            the booking).</li>
          <li>You can cancel a booking until it starts. Once it has started, only the club can change or cancel it.</li>
          <li>If you do not turn up, the club can record it.{" "}
            <Pending kind="proposed">Repeatedly not turning up may lead to limits on booking.</Pending></li>
          <li>A club can cancel a booking, for example for weather or maintenance.</li>
        </ul>
      </Section>

      <Section id="paying" title="Paying">
        <p>Today you pay the club at its desk, as you would for a booking made by phone. Nothing is paid through CourtBook.</p>
        <p><Pending kind="decision">Payment in the app, the booking fee and the refund rules for in-app payments will be
          added here before payment in the app starts.</Pending></p>
      </Section>

      <Section id="games" title="Games and chat">
        <p>When you post a game you choose the level, the number of players and whether you approve each person who asks
          to join. Before your first message, you agree to these community rules:</p>
        <ol className="list-decimal space-y-1 pl-5">{COMMUNITY_RULES.map((r) => <li key={r}>{r}</li>)}</ol>
        <p>You can report a message, a game or a player, and block a player, from the game or from Help in the app.</p>
      </Section>

      <Section id="moderation" title="When rules are broken">
        <p>We review reports. We can hide a message, and suspend an account: a suspended account cannot post, join or
          organise games or send messages until the suspension is lifted.{" "}
          <Pending kind="decision">How quickly reports are reviewed.</Pending></p>
      </Section>

      <Section id="responsibility" title="Our responsibility">
        <p><Pending kind="legal">We try to keep CourtBook working and accurate, but cannot promise it is always available or
          free of errors. We are not responsible for a club’s decisions, a club calendar being wrong, a game that does not
          take place, an injury, or anything lost or damaged at a club. Nothing in these terms removes a responsibility
          that the law does not allow us to remove.</Pending></p>
      </Section>

      <Section id="ending" title="Ending your use">
        <p>You can stop using CourtBook and delete your account at any time. We can suspend or close an account that
          breaks these terms.</p>
      </Section>

      <Section id="changes" title="Changes and law">
        <p><Pending kind="proposed">If these terms change in a way that matters, we will tell you in the app before the
          change takes effect.</Pending>{" "}
          <Pending kind="decision">These terms are governed by the law of [jurisdiction], and its courts decide
          disputes.</Pending></p>
      </Section>
    </LegalPage>
  );
}
