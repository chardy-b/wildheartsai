// SMART v2 scopes: the Epic app is registered for SMART v2, where ".rs" means read and search.
export const EPIC_SCOPES = [
  "openid",
  "fhirUser",
  "launch/patient",
  "offline_access",
  "patient/Patient.rs",
  "patient/Condition.rs",
  "patient/MedicationRequest.rs",
  "patient/MedicationDispense.rs",
  "patient/AllergyIntolerance.rs",
  "patient/Observation.rs",
  "patient/DiagnosticReport.rs",
  "patient/DocumentReference.rs",
  "patient/Binary.rs",
  "patient/Immunization.rs",
  "patient/Encounter.rs",
  "patient/Procedure.rs",
  "patient/ServiceRequest.rs",
  "patient/CareTeam.rs",
  "patient/CarePlan.rs",
  "patient/Goal.rs",
  "patient/Device.rs",
  "patient/Coverage.rs",
] as const;

// Stage 8 scopes: appointments and family history as records, and the resources other
// records point to (medications, clinicians, organizations, locations). Requested only with
// EPIC_EXPANDED_SCOPES=true, once they're enabled in the Epic app registration; a scope Epic
// doesn't allow for the app could fail every sign-in.
export const EXPANDED_SCOPES = [
  "patient/Appointment.rs",
  "patient/FamilyMemberHistory.rs",
  "patient/Medication.rs",
  "patient/Practitioner.rs",
  "patient/PractitionerRole.rs",
  "patient/Organization.rs",
  "patient/Location.rs",
] as const;

export function requestedScopes(expanded: boolean): readonly string[] {
  return expanded ? [...EPIC_SCOPES, ...EXPANDED_SCOPES] : EPIC_SCOPES;
}

// Whether a granted scope string allows reading a resource type. Epic may answer with SMART v1
// (".read") or v2 (".rs") names, or a wildcard.
export function grantsResource(granted: string, resourceType: string): boolean {
  return granted
    .split(/\s+/)
    .some((scope) => {
      const match = /^patient\/([A-Za-z*]+)\.(read|rs|r|\*)$/.exec(scope);
      return match !== null && (match[1] === resourceType || match[1] === "*");
    });
}

// Resource scopes we'd ask for now that a connection wasn't granted: it needs a reconnect to get them.
export function missingScopes(granted: string, expanded: boolean): string[] {
  return requestedScopes(expanded)
    .filter((scope) => scope.startsWith("patient/"))
    .filter((scope) => !grantsResource(granted, scope.slice("patient/".length).split(".")[0]));
}

// Shown on the connections page: "what we ask for", in plain language.
export const SCOPE_LABELS: { scope: string; label: string }[] = [
  { scope: "patient/Patient.rs", label: "Your name and date of birth, to match your record" },
  { scope: "patient/Condition.rs", label: "Conditions, visit diagnoses and health concerns" },
  { scope: "patient/MedicationRequest.rs", label: "Medications you've been prescribed" },
  { scope: "patient/MedicationDispense.rs", label: "Pharmacy fills" },
  { scope: "patient/AllergyIntolerance.rs", label: "Allergies" },
  { scope: "patient/Observation.rs", label: "Lab results, vital signs, assessments and social history" },
  { scope: "patient/DiagnosticReport.rs", label: "Lab and imaging reports" },
  { scope: "patient/DocumentReference.rs", label: "Visit notes and other documents" },
  { scope: "patient/Binary.rs", label: "The text of those notes and documents" },
  { scope: "patient/Immunization.rs", label: "Immunizations" },
  { scope: "patient/Encounter.rs", label: "Visits" },
  { scope: "patient/Procedure.rs", label: "Procedures and surgeries" },
  { scope: "patient/ServiceRequest.rs", label: "Orders, such as tests and referrals" },
  { scope: "patient/CareTeam.rs", label: "Your care team" },
  { scope: "patient/CarePlan.rs", label: "Care plans" },
  { scope: "patient/Goal.rs", label: "Health goals" },
  { scope: "patient/Device.rs", label: "Implanted devices" },
  { scope: "patient/Coverage.rs", label: "Insurance coverage" },
  { scope: "patient/Appointment.rs", label: "Your appointments, including upcoming ones" },
  { scope: "patient/FamilyMemberHistory.rs", label: "Family health history" },
  { scope: "patient/Medication.rs", label: "Details of your medications, such as strength and form" },
  { scope: "patient/Practitioner.rs", label: "The names of clinicians on your records" },
  { scope: "patient/PractitionerRole.rs", label: "Your clinicians' roles and specialties" },
  { scope: "patient/Organization.rs", label: "The organizations your records come from" },
  { scope: "patient/Location.rs", label: "Where your visits took place" },
  { scope: "offline_access", label: "Staying connected, so you don't sign in to MyChart every time" },
];

// The labels for what a connection asks for, in the order above.
export function scopeLabels(expanded: boolean): { scope: string; label: string }[] {
  const requested = new Set(requestedScopes(expanded));
  return SCOPE_LABELS.filter((item) => requested.has(item.scope));
}

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
