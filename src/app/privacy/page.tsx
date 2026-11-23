import Link from "next/link";
import { LegalPage, Pending, Section } from "@/components/legal";
import { CONTACT_EMAIL, LEGAL_STATUS } from "@/lib/legal";

/**
 * M5: the privacy policy. Public (no sign-in, nothing read about the visitor), linked from sign-in, profile, the 18+
 * question, the deletion page and the apps; it is the URL given to both app stores.
 * Every unmarked statement describes what the code does today; the evidence for each is in docs/m5/privacy-evidence.md.
 * Marked items (Pending) are not final. Do not add a commitment here without the evidence or a decision behind it.
 */
export const metadata = {
  title: "Privacy policy — CourtBook",
  robots: LEGAL_STATUS === "draft" ? { index: false, follow: false } : undefined,
};

export default function PrivacyPage() {
  return (
    <LegalPage
      path="/privacy"
      title="Privacy policy"
      intro={<p>
        This explains what CourtBook collects when you use the website or the CourtBook app on iPhone or Android, why, who
        can see it, how long it is kept, and what you can do about it. CourtBook is run by{" "}
        <Pending kind="decision">[operator: name of the company that runs CourtBook]</Pending>, of{" "}
        <Pending kind="decision">[postal address]</Pending>. You can reach us at <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-turf">{CONTACT_EMAIL}</a>.
      </p>}
    >
      <Section id="collect" title="What we collect and why">
        <h3 className="font-semibold">Your account</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li><b>Email address</b>, to sign you in. You sign in with a code we email you, with Google, or with Apple on iPhone.
            If you use Google or Apple, our sign-in service keeps the details they send for that sign-in, such as your
            email address and, from Google, your name. We never receive a password from you.</li>
          <li><b>Your name</b>, so a club knows who booked and the players in your games know who you are.</li>
          <li><b>Phone number</b>, only if you add one. The club you book with can see it, to reach you about the booking.</li>
          <li><b>Your sports and playing level</b>, which you choose yourself, to match you with suitable games.</li>
          <li><b>Your answer to “Are you 18 or over?”</b>, with when and where you gave it (app or website). We keep
            nothing else about your age.</li>
          <li>When you accepted the community rules, and your choice about game alerts by email (we do not send these
            emails at present).</li>
        </ul>

        <h3 className="mt-2 font-semibold">Bookings and payments</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>For each booking: the club, court, date and time, price, how it was made, and whether it was kept,
            cancelled or missed.</li>
          <li>Today you pay the club at its desk, and nothing is paid through CourtBook. Where a booking has a payment
            record, it holds the amount, any fee, its status and the payment provider’s reference.{" "}
            <Pending kind="proposed">When payment in the app is introduced, card details will be handled by the payment
            provider and never seen or stored by CourtBook. The provider will be named here before that starts.</Pending></li>
        </ul>

        <h3 className="mt-2 font-semibold">Games and chat</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>Games you post or join: the club, time, level range, your note, join requests and who took part.</li>
          <li>Messages you send in a game’s chat. A message you delete is removed for everyone; if someone had already
            reported it, the report keeps its copy until that copy is cleared (see “How long we keep it”). You can also
            remove a finished game from your own list.</li>
        </ul>

        <h3 className="mt-2 font-semibold">Safety and support</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>Players you block.</li>
          <li>Reports you make about a message, a game or a player, with a copy of what was reported, and the problems and
            suggestions you send us from the app.</li>
          <li>What our moderators decide about a report and any note they add, and any suspension of an account.</li>
          <li>Your account deletion request, if you make one: when and how you asked, and its progress.</li>
        </ul>

        <h3 className="mt-2 font-semibold">Coaches and club staff</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>If you are a coach: your coach profile, including the price, description and WhatsApp number you choose to
            show to signed-in players.</li>
          <li>If you work at a club: your staff role, the bookings, blocks and changes you make, and the photos you upload
            for the club.</li>
        </ul>

        <h3 className="mt-2 font-semibold">Error reports and server records</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>When something goes wrong, the website and the app send an error report so we can fix it: the error, the
            page or screen, the app version, and the device type and system version. Reports leave out your name, your account
            and your network address, and email addresses are removed from them.{" "}
            <Pending kind="decision">The app’s own crash reports may also carry a random identifier for the installation
            (not linked to your account); to be confirmed on a test report before publication.</Pending></li>
          <li>Our hosting and database providers keep ordinary server records, including network (IP) addresses, for
            security and to fix problems.</li>
        </ul>

        <h3 className="mt-2 font-semibold">On your device</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>The app keeps your sign-in in the phone’s secure storage. The website keeps your sign-in in cookies and
            remembers the area and sport you last chose in your browser.</li>
        </ul>
      </Section>

      <Section id="not-collected" title="What we do not do">
        <ul className="list-disc space-y-1 pl-5">
          <li>We do not use your location. Clubs are found by the area you choose, not by your device’s position.</li>
          <li>The app does not ask for access to your contacts, photos, camera or microphone.</li>
          <li>We show no advertising, use no advertising or analytics trackers, do not track you across other apps or
            websites, and do not sell information about you.</li>
        </ul>
      </Section>

      <Section id="who-sees" title="Who can see what">
        <ul className="list-disc space-y-1 pl-5">
          <li><b>Other players</b> see the name of a game’s organiser, the game’s details, and how many have joined. Only
            the players in a game see each other’s names and that game’s chat. Other players never see your email address
            or phone number through CourtBook.</li>
          <li><b>A club’s staff</b> see your name and phone number (if you gave one) for your bookings at that club
            only.</li>
          <li><b>Anyone</b> can see whether a court is free or busy, but not who booked it.</li>
          <li><b>CourtBook’s administrators</b> can see what is needed to run the service, handle reports, and process
            deletion requests.</li>
          <li><b>Our service providers</b> process data for us: Supabase (database and sign-in, hosted in Frankfurt,
            Germany), Vercel (website, Frankfurt), Google (sending sign-in emails, and Google sign-in if you use it), Apple
            (Sign in with Apple), Sentry (error reports), and Expo (delivering app updates).{" "}
            <Pending kind="legal">Confirm the list, where each provider processes data, and the wording on transfers
            outside Lebanon.</Pending></li>
          <li><Pending kind="legal">When the law requires us to share information, for example with a court or the
            police.</Pending></li>
        </ul>
      </Section>

      <Section id="how-long" title="How long we keep it">
        <ul className="list-disc space-y-1 pl-5">
          <li>Your account and what belongs to it are kept while your account exists.</li>
          <li>An unpaid booking hold expires after a few minutes.</li>
          <li>Reports: once a report has been closed for 180 days, the copy of the reported content and the note
            written by the person who reported it are due to be cleared. Clearing does not run on a timer: it runs
            each time anyone files a new report and each time an administrator opens the reports page, so this text
            can stay for some time after the 180 days. It is never cleared while the report is open or under a legal
            hold. The report itself (its kind, reason, dates and decision) is kept without this text.{" "}
            <Pending kind="decision">Whether we promise a latest date for clearing (that needs a scheduled clearing
            job, which is not built), and how long the report itself is kept.</Pending></li>
          <li>Notes written by administrators while handling reports and suspensions are cleared the same way once
            the note itself is 180 days old (counted from when it was written, not from when the report closed). They
            are kept while their report is open or under a legal hold, and while a suspension they concern is still
            in force.</li>
          <li>If you delete your account, we delete or anonymise your data as described on{" "}
            <Link href="/delete-account" className="font-semibold text-turf">Delete your account</Link>.{" "}
            <Pending kind="legal">How long past bookings and payment records are kept without your name, and how long
            server records are kept.</Pending></li>
        </ul>
      </Section>

      <Section id="choices" title="Your choices and rights">
        <ul className="list-disc space-y-1 pl-5">
          <li>Change your name, phone number, sports and level in your profile at any time.</li>
          <li>Delete your own chat messages, block players, and remove finished games from your list.</li>
          <li>Delete your account in the app or on the website (Profile → Delete my account), or by email — see{" "}
            <Link href="/delete-account" className="font-semibold text-turf">Delete your account</Link>.</li>
          <li>Ask us at {CONTACT_EMAIL} for a copy of your information or to correct it.{" "}
            <Pending kind="legal">The rights that apply under Lebanese law and how quickly we answer.</Pending></li>
        </ul>
      </Section>

      <Section id="age" title="Age">
        <p>CourtBook is for people aged 18 and over. We ask once, before you book, join a game or chat.{" "}
          <Pending kind="proposed">If we learn that an account belongs to someone under 18, we will close it.</Pending></p>
      </Section>

      <Section id="security" title="Security">
        <p>Everything between your device and CourtBook travels encrypted. Access rules in our database decide who can
          read or change each piece of information, so players, club staff and administrators each see only what their
          role allows.</p>
      </Section>

      <Section id="changes" title="Changes to this policy">
        <p><Pending kind="proposed">If we change this policy in a way that matters, we will tell you in the app before the
          change takes effect, and update the date at the top.</Pending></p>
      </Section>
    </LegalPage>
  );
}
