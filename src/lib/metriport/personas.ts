// Metriport's sandbox returns mock records for patients whose first name matches one of these
// personas (https://docs.metriport.com/medical-api/getting-started/sandbox). Made-up people, not PHI.

export type Persona = {
  id: string;
  firstName: string;
  lastName: string;
  dob: string;
  genderAtBirth: "F" | "M";
  address: { addressLine1: string; city: string; state: string; zip: string; country: "USA" };
};

export const PERSONAS: Persona[] = [
  { id: "jane", firstName: "Jane", lastName: "Smith", dob: "1996-02-10", genderAtBirth: "F", address: { addressLine1: "123 Arsenal St", city: "Phoenix", state: "AZ", zip: "85300", country: "USA" } },
  { id: "chris", firstName: "Chris", lastName: "Smith", dob: "1995-01-01", genderAtBirth: "M", address: { addressLine1: "123 Atlantis Rd", city: "Chicago", state: "IL", zip: "60601", country: "USA" } },
  { id: "ollie", firstName: "Ollie", lastName: "Brown", dob: "1946-03-18", genderAtBirth: "M", address: { addressLine1: "201 Armada St", city: "Harrisburg", state: "PA", zip: "15300", country: "USA" } },
  { id: "andreas", firstName: "Andreas", lastName: "Brown", dob: "1952-01-01", genderAtBirth: "M", address: { addressLine1: "4430 York St", city: "Jefferson City", state: "MO", zip: "64000", country: "USA" } },
  { id: "kyla", firstName: "Kyla", lastName: "Fields", dob: "1927-05-23", genderAtBirth: "F", address: { addressLine1: "332 16th St", city: "Portland", state: "ME", zip: "04000", country: "USA" } },
];

export function personaById(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}

// The health_source address for a persona. Not a real URL: sources are unique per (user, address).
export function personaSourceUrl(persona: Persona): string {
  return `metriport:sandbox/${persona.id}`;
}

export function personaOrganizationName(persona: Persona): string {
  return `Metriport sandbox: ${persona.firstName} ${persona.lastName} (sample HIE patient)`;
}

export function isMetriportSource(source: { fhirBaseUrl: string }): boolean {
  return source.fhirBaseUrl.startsWith("metriport:sandbox/");
}
