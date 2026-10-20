import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrgSearch } from "./OrgSearch";

vi.mock("./OrgSearchForm", () => ({ OrgSearchForm: () => null }));

const organization = { name: "NYU Langone", fhirBaseUrl: "https://nyu.example/FHIR/R4" };

function render(status?: "connected" | "reconnect_required" | "disconnected") {
  return renderToStaticMarkup(createElement(OrgSearch, {
    environment: "production",
    query: "NYU Langone",
    results: [organization],
    sample: null,
    formAction: "/app/connections",
    connections: status ? [{ id: "source-1", fhirBaseUrl: `${organization.fhirBaseUrl}/`, status }] : [],
  }));
}

describe("health system search connection actions", () => {
  it("keeps a connected system visible and links to its existing connection", () => {
    const html = render("connected");
    expect(html).toContain("NYU Langone");
    expect(html).toContain("Connected");
    expect(html).toContain('href="#source-source-1"');
    expect(html).toContain("View connection");
    expect(html).not.toContain("/api/epic/authorize");
  });

  it("offers reconnection directly from search when authorization is needed", () => {
    const html = render("reconnect_required");
    expect(html).toContain("Needs you to sign in again");
    expect(html).toContain("/api/epic/authorize?");
    expect(html).toContain("Reconnect");
    expect(html).not.toContain("No health systems match");
  });

  it("offers reconnection for a disconnected system and connection for a new one", () => {
    expect(render("disconnected")).toContain("Reconnect");
    expect(render("disconnected")).toContain("Disconnected");
    expect(render()).toContain(">Connect</a>");
  });
});
