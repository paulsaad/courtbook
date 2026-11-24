// The website's service-role client (src/lib/supabase/admin.ts) in the local harness: the service key of the local API.
import { asService } from "../lib.mjs";
export const createAdminClient = () => asService();
