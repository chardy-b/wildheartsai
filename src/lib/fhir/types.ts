// Only the FHIR R4 fields Wild Hearts reads. Everything is optional because
// health systems populate resources differently.
export type Coding = { system?: string; code?: string; display?: string };
export type CodeableConcept = { text?: string; coding?: Coding[] };
export type Reference = { reference?: string; display?: string };
export type Quantity = { value?: number; unit?: string };

export type Resource = { resourceType: string; id?: string };

export type Bundle = {
  resourceType: "Bundle";
  link?: { relation: string; url: string }[];
  entry?: { resource?: Resource }[];
};

export type Condition = Resource & {
  resourceType: "Condition";
  code?: CodeableConcept;
  clinicalStatus?: CodeableConcept;
  onsetDateTime?: string;
  recordedDate?: string;
};

export type MedicationRequest = Resource & {
  resourceType: "MedicationRequest";
  status?: string;
  medicationCodeableConcept?: CodeableConcept;
  medicationReference?: Reference;
  authoredOn?: string;
  dosageInstruction?: { text?: string }[];
};

export type AllergyIntolerance = Resource & {
  resourceType: "AllergyIntolerance";
  code?: CodeableConcept;
  clinicalStatus?: CodeableConcept;
  recordedDate?: string;
  reaction?: { manifestation?: CodeableConcept[] }[];
};

export type Observation = Resource & {
  resourceType: "Observation";
  status?: string;
  code?: CodeableConcept;
  effectiveDateTime?: string;
  issued?: string;
  valueQuantity?: Quantity;
  valueString?: string;
  valueCodeableConcept?: CodeableConcept;
  interpretation?: CodeableConcept[];
};

export type Immunization = Resource & {
  resourceType: "Immunization";
  status?: string;
  vaccineCode?: CodeableConcept;
  occurrenceDateTime?: string;
};

export type Encounter = Resource & {
  resourceType: "Encounter";
  status?: string;
  type?: CodeableConcept[];
  class?: Coding;
  period?: { start?: string };
  serviceProvider?: Reference;
};
