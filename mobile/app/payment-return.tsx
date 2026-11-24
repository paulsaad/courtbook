import { useEffect } from "react";
import { router } from "expo-router";
import { Loading } from "../components/StateView";
import { useSession } from "../lib/session";
import { payController } from "../lib/payments";

/**
 * courtbook://payment-return (courtbook-staging:// in the staging app): where the payment page hands back when the
 * app was not waiting for it (it had been closed or killed). The link carries nothing; this screen opens the payment
 * this account was in the middle of, whose screen then asks the server. Nothing here is proof of payment.
 */
export default function PaymentReturn() {
  const session = useSession();
  useEffect(() => {
    if (session.status === "loading") return;
    if (session.status !== "signed-in") { router.replace("/sign-in"); return; }
    void payController().load(session.session.user.id).then((s) => {
      if (s) router.replace({ pathname: "/pay/[id]", params: { id: s.bookingId } });
      else router.replace("/bookings");
    });
  }, [session]);
  return <Loading label="Checking your payment" />;
}
