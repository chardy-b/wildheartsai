// Builders for Epic's published directory lists (Brands bundle and R4 endpoint list), same shapes
// as the real ones. Made-up organizations only.
export function brandsBundle(
  brands: { name: string; address: string; status?: string; facilities?: { name: string; city?: string; state?: string }[] }[],
) {
  const entry: { fullUrl: string; resource: Record<string, unknown> }[] = [];
  brands.forEach((brand, i) => {
    const endpointUrl = `urn:uuid:endpoint-${i}`;
    const brandUrl = `urn:uuid:brand-${i}`;
    entry.push({
      fullUrl: brandUrl,
      resource: { resourceType: "Organization", name: brand.name, endpoint: [{ reference: endpointUrl }] },
    });
    entry.push({
      fullUrl: endpointUrl,
      resource: { resourceType: "Endpoint", status: brand.status ?? "active", name: brand.name, address: brand.address },
    });
    (brand.facilities ?? []).forEach((facility, j) => {
      entry.push({
        fullUrl: `urn:uuid:facility-${i}-${j}`,
        resource: {
          resourceType: "Organization",
          name: facility.name,
          address: [{ city: facility.city, state: facility.state }],
          partOf: { reference: brandUrl },
        },
      });
    });
  });
  return { resourceType: "Bundle", type: "collection", entry };
}

export function r4List(endpoints: { name: string; address: string }[]) {
  return {
    resourceType: "Bundle",
    entry: endpoints.map(({ name, address }) => ({ resource: { resourceType: "Endpoint", status: "active", name, address } })),
  };
}
