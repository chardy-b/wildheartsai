// SMART v2 scopes: the Epic app is registered for SMART v2, where ".rs" means read and search.
export const EPIC_SCOPES = [
  "openid",
  "fhirUser",
  "launch/patient",
  "offline_access",
  "patient/Patient.rs",
  "patient/Condition.rs",
  "patient/MedicationRequest.rs",
  "patient/AllergyIntolerance.rs",
  "patient/Observation.rs",
  "patient/Immunization.rs",
  "patient/Encounter.rs",
] as const;

// Shown on the connections page: "what we ask for", in plain language.
export const SCOPE_LABELS: { scope: string; label: string }[] = [
  { scope: "patient/Patient.rs", label: "Your name and date of birth, to match your record" },
  { scope: "patient/Condition.rs", label: "Conditions on your problem list" },
  { scope: "patient/MedicationRequest.rs", label: "Medications you've been prescribed" },
  { scope: "patient/AllergyIntolerance.rs", label: "Allergies" },
  { scope: "patient/Observation.rs", label: "Lab results" },
  { scope: "patient/Immunization.rs", label: "Immunizations" },
  { scope: "patient/Encounter.rs", label: "Visits" },
  { scope: "offline_access", label: "Staying connected, so you don't sign in to MyChart every time" },
];

export function buildAuthorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  aud: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: (input.scopes ?? EPIC_SCOPES).join(" "),
    state: input.state,
    aud: input.aud,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}
