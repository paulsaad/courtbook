// Before spending a build: are the signing credentials for this app in EAS?
// Reads EAS (read only) with EXPO_TOKEN and prints what it finds for both platforms, without any
// secret: Android keystore type, alias and creation date; iOS distribution type, certificate expiry,
// provisioning profile expiry and how many devices it holds. Fails if the platform being built has
// none, so a missing key stops the run here instead of in the build.
// Usage: node eas-credentials-check.mjs <bundle-id> <android|ios>
const [bundleId, platform] = process.argv.slice(2);
const token = process.env.EXPO_TOKEN;
if (!bundleId || !["android", "ios"].includes(platform) || !token) {
  console.error("usage: eas-credentials-check.mjs <bundle-id> <android|ios> (EXPO_TOKEN set)");
  process.exit(2);
}

const query = `query($fullName: String!, $appId: String!) {
  app { byFullName(fullName: $fullName) {
    androidAppCredentials(filter: { applicationIdentifier: $appId }) {
      applicationIdentifier
      androidAppBuildCredentialsList { name isDefault androidKeystore { type keyAlias createdAt } }
    }
    iosAppCredentials {
      appleAppIdentifier { bundleIdentifier }
      iosAppBuildCredentialsList {
        iosDistributionType
        distributionCertificate { validityNotAfter }
        provisioningProfile { expiration status appleDevices { id } }
      }
    }
  } }
}`;

const res = await fetch("https://api.expo.dev/graphql", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ query, variables: { fullName: "@paulsaad/courtbook", appId: bundleId } }),
});
const body = await res.json();
if (body.errors) {
  console.error("EAS query failed:", JSON.stringify(body.errors).slice(0, 800));
  process.exit(1);
}
const app = body.data.app.byFullName;

const android = (app.androidAppCredentials ?? [])
  .filter((c) => c.applicationIdentifier === bundleId)
  .flatMap((c) => c.androidAppBuildCredentialsList)
  .filter((b) => b.androidKeystore);
const ios = (app.iosAppCredentials ?? [])
  .filter((c) => c.appleAppIdentifier?.bundleIdentifier === bundleId)
  .flatMap((c) => c.iosAppBuildCredentialsList)
  .filter((b) => b.distributionCertificate && b.provisioningProfile);

console.log(`Signing credentials in EAS for ${bundleId}:`);
for (const b of android)
  console.log(`  android: keystore ${b.androidKeystore.type}, alias set: ${!!b.androidKeystore.keyAlias}, created ${b.androidKeystore.createdAt}${b.isDefault ? " (default)" : ""}`);
if (!android.length) console.log("  android: none");
for (const b of ios)
  console.log(`  ios: ${b.iosDistributionType}, certificate valid until ${b.distributionCertificate.validityNotAfter}, profile ${b.provisioningProfile.status ?? "?"} until ${b.provisioningProfile.expiration}, ${b.provisioningProfile.appleDevices?.length ?? 0} device(s)`);
if (!ios.length) console.log("  ios: none");

if ((platform === "android" ? android : ios).length === 0) {
  console.log(`::error::No ${platform} signing credentials in EAS for ${bundleId}. Nothing was built.`);
  process.exit(1);
}
