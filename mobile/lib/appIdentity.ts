import * as Application from "expo-application";
import { variantFromAppId, type Variant } from "./variant";

/** Which installed app this is, from its native bundle ID (null outside a native build). */
export const installedVariant: Variant | null = variantFromAppId(Application.applicationId);
