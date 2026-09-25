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
  // Multi-part results, such as blood pressure (systolic and diastolic).
  component?: { code?: CodeableConcept; valueQuantity?: Quantity }[];
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

export type Period = { start?: string; end?: string };
export type Attachment = { contentType?: string; url?: string; title?: string; size?: number };

export type DiagnosticReport = Resource & {
  resourceType: "DiagnosticReport";
  status?: string;
  category?: CodeableConcept[];
  code?: CodeableConcept;
  effectiveDateTime?: string;
  issued?: string;
  conclusion?: string;
  result?: Reference[];
  performer?: Reference[];
  presentedForm?: Attachment[];
};

export type DocumentReference = Resource & {
  resourceType: "DocumentReference";
  status?: string;
  docStatus?: string;
  type?: CodeableConcept;
  category?: CodeableConcept[];
  date?: string;
  description?: string;
  author?: Reference[];
  content?: { attachment?: Attachment }[];
  context?: { encounter?: Reference[]; period?: Period };
};

export type Procedure = Resource & {
  resourceType: "Procedure";
  status?: string;
  code?: CodeableConcept;
  performedDateTime?: string;
  performedPeriod?: Period;
  reasonCode?: CodeableConcept[];
  bodySite?: CodeableConcept[];
};

export type CareTeam = Resource & {
  resourceType: "CareTeam";
  status?: string;
  name?: string;
  period?: Period;
  participant?: { role?: CodeableConcept[]; member?: Reference }[];
};

export type CarePlan = Resource & {
  resourceType: "CarePlan";
  status?: string;
  title?: string;
  description?: string;
  category?: CodeableConcept[];
  period?: Period;
  created?: string;
};

export type Goal = Resource & {
  resourceType: "Goal";
  lifecycleStatus?: string;
  description?: CodeableConcept;
  startDate?: string;
  target?: { dueDate?: string }[];
};

export type ServiceRequest = Resource & {
  resourceType: "ServiceRequest";
  status?: string;
  code?: CodeableConcept;
  authoredOn?: string;
  requester?: Reference;
};

export type MedicationDispense = Resource & {
  resourceType: "MedicationDispense";
  status?: string;
  medicationCodeableConcept?: CodeableConcept;
  medicationReference?: Reference;
  whenHandedOver?: string;
  whenPrepared?: string;
  quantity?: Quantity;
  daysSupply?: Quantity;
};

export type Device = Resource & {
  resourceType: "Device";
  status?: string;
  deviceName?: { name?: string }[];
  type?: CodeableConcept;
  manufacturer?: string;
};

export type Coverage = Resource & {
  resourceType: "Coverage";
  status?: string;
  type?: CodeableConcept;
  payor?: Reference[];
  period?: Period;
};
