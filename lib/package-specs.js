// Canonical turnkey package sheets: every package is a list of accordion groups,
// and every group holds the line items shown when a visitor expands it.
// This file is the single source of truth for seeding a new database and for
// `npm run packages:sync`, which pushes these sheets into the live database.

const PACKAGE_PLANS = [
  {
    name: 'Elegance',
    rate: 1999,
    badge: null,
    groups: [
      ['Design & Development', [
        ['2D floor plan', 'Included (2 revisions)'],
        ['3D elevation', 'Included (1 view)'],
        ['Working drawings (GFC)', 'Included'],
        ['Structural drawings', 'Included, as per IS 456 and IS 1893'],
        ['MEP drawings', 'Included'],
        ['VR / AR walkthrough', 'Not included']
      ]],
      ['Structure', [
        ['Steel', 'Kamadhenu / A1 Gold or equivalent, Fe 500D'],
        ['Cement', 'Zuari / Dalmia or equivalent, 43 or 53 grade'],
        ['Aggregates', '20 mm and 40 mm machine-crushed'],
        ['Blocks', 'Solid concrete blocks, 6" and 4"'],
        ['RCC mix', 'M25 design mix'],
        ['Ceiling height', "10'0\" floor to floor"],
        ['Soil test', 'Included']
      ]],
      ['Kitchen', [
        ['Countertop', 'Granite up to ₹120/sq ft'],
        ['Wall tiles above counter', 'Up to ₹40/sq ft, 2 ft height'],
        ['Kitchen sink', 'Stainless steel single bowl up to ₹3,000'],
        ['Sink faucet', 'Up to ₹1,500'],
        ['Accessories', 'ISI-marked']
      ]],
      ['Bathroom', [
        ['Sanitaryware & CP fittings', 'Up to ₹16,500 per bathroom (commode, mixer, health faucet, soap dish, towel rail)'],
        ['Wall tiles', 'Up to ₹40/sq ft, 7\'0" height'],
        ['Bathroom door', 'Waterproof flush door up to ₹7,000'],
        ['Glass partition', 'Not included']
      ]],
      ['Plumbing & Water', [
        ['CPVC pipes', 'Astral / Prince or equivalent'],
        ['Overhead tank', 'Sintex triple-layer, 1,000 litres'],
        ['Underground sump', '6,000 litres, 6" solid block'],
        ['Geyser / solar provision', 'Included'],
        ['Rainwater harvesting', 'Included']
      ]],
      ['Doors & Windows', [
        ['Main door', 'Teak frame and shutter up to ₹20,000 with fittings'],
        ['Internal doors', 'Sal wood frame with 30 mm flush shutter up to ₹8,000'],
        ['Pooja room door', 'Not included'],
        ['Windows', 'Aluminium 3-track with mesh up to ₹250/sq ft'],
        ['Window grills', 'MS with enamel paint up to ₹115/sq ft'],
        ['Window opening', '10% of package built-up area']
      ]],
      ['Painting', [
        ['Interior', 'JK putty + Tractor emulsion, 2 coats'],
        ['Exterior', 'Asian primer + Ace emulsion'],
        ['Ceiling', '2 coats emulsion']
      ]],
      ['Flooring', [
        ['Living & dining', 'Vitrified tiles up to ₹60/sq ft'],
        ['Rooms & kitchen', 'Tiles up to ₹60/sq ft'],
        ['Balcony & open areas', 'Anti-skid tiles up to ₹45/sq ft'],
        ['Staircase', 'Sadarhalli granite up to ₹80/sq ft'],
        ['Bathroom', 'Anti-skid tiles up to ₹45/sq ft'],
        ['Parking', 'Parking tiles up to ₹40/sq ft']
      ]],
      ['Electrical', [
        ['Wires', 'Fire-retardant, Anchor or equivalent'],
        ['Switches & sockets', 'GM basic or equivalent'],
        ['Distribution board', 'ISI-marked MCBs'],
        ['Light & fan points', 'As per the approved electrical layout'],
        ['CCTV / UPS / EV wiring', 'Not included']
      ]],
      ['Elevation & Extras', [
        ['Elevation work', '0.25% of project value'],
        ['Staircase & balcony railings', 'MS railings up to ₹150/sq ft'],
        ['Anti-termite treatment', 'Included'],
        ['Home automation', 'Not included'],
        ['Digital lock & wireless CCTV', 'Not included'],
        ['Design revisions', '2 rounds']
      ]]
    ]
  },
  {
    name: 'Premium',
    rate: 2149,
    badge: 'Most Chosen',
    groups: [
      ['Design & Development', [
        ['2D floor plan', 'Included (3 revisions)'],
        ['3D elevation', 'Included (2 views)'],
        ['Working drawings (GFC)', 'Included'],
        ['Structural drawings', 'Included, as per IS 456 and IS 1893'],
        ['MEP drawings', 'Included'],
        ['VR / AR walkthrough', 'Not included']
      ]],
      ['Structure', [
        ['Steel', 'JSW Neo / Indus or equivalent, Fe 500D'],
        ['Cement', 'ACC / Ramco or equivalent, 43 or 53 grade'],
        ['Aggregates', '20 mm and 40 mm machine-crushed'],
        ['Blocks', 'Solid concrete blocks, 6" and 4"'],
        ['RCC mix', 'M25 design mix'],
        ['Ceiling height', "10'6\" floor to floor"],
        ['Soil test', 'Included']
      ]],
      ['Kitchen', [
        ['Countertop', 'Granite up to ₹150/sq ft'],
        ['Wall tiles above counter', 'Up to ₹70/sq ft, 2 ft height'],
        ['Kitchen sink', 'Stainless steel single bowl up to ₹6,000'],
        ['Sink faucet', 'Up to ₹3,000'],
        ['Faucets & accessories', 'Jaguar / Parryware / Hindware or equivalent']
      ]],
      ['Bathroom', [
        ['Sanitaryware & CP fittings', 'Up to ₹28,000 per bathroom (commode, mixer, health faucet, soap dish, towel rail)'],
        ['Wall tiles', 'Up to ₹60/sq ft, 7\'0" height'],
        ['Bathroom door', 'Waterproof flush door up to ₹9,000'],
        ['Glass partition', 'Not included']
      ]],
      ['Plumbing & Water', [
        ['CPVC pipes', 'Ashirwad / Supreme or equivalent'],
        ['Overhead tank', 'Sintex triple-layer, 2,000 litres'],
        ['Underground sump', '8,000 litres, 6" solid block'],
        ['Geyser / solar provision', 'Included'],
        ['Rainwater harvesting', 'Included']
      ]],
      ['Doors & Windows', [
        ['Main door', 'Teak frame and shutter up to ₹40,000 with fittings'],
        ['Internal doors', 'Sal wood frame with 30 mm flush shutter up to ₹11,000'],
        ['Pooja room door', 'Teak frame and shutter up to ₹30,000'],
        ['Windows', 'UPVC with glass and mesh up to ₹450/sq ft'],
        ['Window grills', 'MS with enamel paint up to ₹150/sq ft'],
        ['Window opening', '10% of package built-up area']
      ]],
      ['Painting', [
        ['Interior', 'JK putty + Apcolite Premium emulsion, 2 coats'],
        ['Exterior', 'Asian primer + Apex emulsion'],
        ['Ceiling', '2 coats emulsion']
      ]],
      ['Flooring', [
        ['Living & dining', 'Granite or vitrified tiles up to ₹100/sq ft'],
        ['Rooms & kitchen', 'Tiles up to ₹80/sq ft'],
        ['Balcony & open areas', 'Anti-skid tiles up to ₹60/sq ft'],
        ['Staircase', 'Polished granite up to ₹100/sq ft'],
        ['Bathroom', 'Anti-skid tiles up to ₹60/sq ft'],
        ['Parking', 'Parking tiles up to ₹60/sq ft'],
        ['Pooja room wall tiles', 'Up to ₹60/sq ft, 7\'0" height']
      ]],
      ['Electrical', [
        ['Wires', 'Fire-retardant, Finolex or equivalent'],
        ['Switches & sockets', 'Anchor Roma or equivalent'],
        ['Distribution board', 'ISI-marked MCBs'],
        ['Light & fan points', 'As per the approved electrical layout'],
        ['CCTV / UPS / EV wiring', 'Provision included']
      ]],
      ['Elevation & Extras', [
        ['Elevation work', '0.5% of project value'],
        ['Staircase & balcony railings', 'MS railings up to ₹200/sq ft'],
        ['Anti-termite treatment', 'Included'],
        ['Home automation', 'Not included'],
        ['Digital lock & wireless CCTV', 'Not included'],
        ['Design revisions', '3 rounds']
      ]]
    ]
  },
  {
    name: 'Elite',
    rate: 2299,
    badge: 'Best Value',
    groups: [
      ['Design & Development', [
        ['2D floor plan', 'Included (3 revisions)'],
        ['3D elevation', 'Included (3 views)'],
        ['Working drawings (GFC)', 'Included'],
        ['Structural drawings', 'Included, as per IS 456 and IS 1893'],
        ['MEP drawings', 'Included'],
        ['VR / AR walkthrough', 'Not included']
      ]],
      ['Structure', [
        ['Steel', 'JSW Neo / Indus or equivalent, Fe 500D'],
        ['Cement', 'Birla / UltraTech or equivalent, 43 or 53 grade'],
        ['Aggregates', '20 mm and 40 mm machine-crushed'],
        ['Blocks', 'Hydraulic pressed blocks, 6" and 4" (Apco / AVS or equivalent)'],
        ['RCC mix', 'M25 design mix'],
        ['Ceiling height', "10'6\" floor to floor"],
        ['Soil test', 'Included']
      ]],
      ['Kitchen', [
        ['Countertop', 'Granite or quartz up to ₹400/sq ft'],
        ['Wall tiles above counter', 'Up to ₹80/sq ft, 2 ft height'],
        ['Kitchen sink', 'Stainless steel or granite-finish up to ₹8,000'],
        ['Sink faucet', 'Up to ₹3,500'],
        ['Faucets & accessories', 'Jaguar / Parryware / Hindware or equivalent']
      ]],
      ['Bathroom', [
        ['Sanitaryware & CP fittings', 'Up to ₹35,000 per bathroom (commode, mixer, health faucet, soap dish, towel rail)'],
        ['Wall tiles', 'Up to ₹70/sq ft, full height'],
        ['Bathroom door', 'Waterproof flush door up to ₹11,000'],
        ['Glass partition', 'Not included']
      ]],
      ['Plumbing & Water', [
        ['CPVC pipes', 'Ashirwad / Supreme or equivalent'],
        ['Overhead tank', 'Sintex triple-layer, 2,000 litres'],
        ['Underground sump', '9,000 litres, 6" solid block'],
        ['Geyser / solar provision', 'Included'],
        ['Rainwater harvesting', 'Included']
      ]],
      ['Doors & Windows', [
        ['Main door', 'Teak frame and shutter up to ₹50,000 with fittings'],
        ['Internal doors', 'Sal wood frame with 30 mm flush shutter up to ₹13,000'],
        ['Pooja room door', 'Teak frame and shutter up to ₹35,000'],
        ['Windows', 'UPVC with glass and mesh up to ₹650/sq ft'],
        ['Window grills', 'MS with enamel paint up to ₹150/sq ft'],
        ['Window opening', '10% of package built-up area']
      ]],
      ['Painting', [
        ['Interior', 'Birla putty + Apcolite Premium emulsion, 2 coats'],
        ['Exterior', 'Asian primer + Apex emulsion'],
        ['Ceiling', '2 coats emulsion']
      ]],
      ['Flooring', [
        ['Living & dining', 'Premium vitrified tiles or granite up to ₹120/sq ft'],
        ['Rooms & kitchen', 'Premium vitrified tiles or granite up to ₹120/sq ft'],
        ['Balcony & open areas', 'Anti-skid tiles up to ₹80/sq ft'],
        ['Staircase', 'Polished granite up to ₹110/sq ft'],
        ['Bathroom', 'Anti-skid tiles up to ₹80/sq ft'],
        ['Parking', 'Parking tiles up to ₹70/sq ft'],
        ['Pooja room wall tiles', 'Up to ₹70/sq ft, 7\'0" height']
      ]],
      ['Electrical', [
        ['Wires', 'Fire-retardant, Havells or equivalent'],
        ['Switches & sockets', 'GM Modular / Legrand or equivalent'],
        ['Distribution board', 'ISI-marked MCBs'],
        ['Light & fan points', 'As per the approved electrical layout'],
        ['CCTV / UPS / EV wiring', 'Provision included']
      ]],
      ['Elevation & Extras', [
        ['Elevation work', '0.75% of project value'],
        ['Internal lofts', '50 sq ft at ₹350/sq ft'],
        ['Staircase & balcony railings', 'SS railings up to ₹400/sq ft'],
        ['Anti-termite treatment', 'Included'],
        ['Home automation', 'Not included'],
        ['Digital lock & wireless CCTV', 'Not included'],
        ['Design revisions', '3 rounds']
      ]]
    ]
  },
  {
    name: 'Luxury',
    rate: 2399,
    badge: null,
    groups: [
      ['Design & Development', [
        ['2D floor plan', 'Included (unlimited revisions)'],
        ['3D elevation', 'Included (3 views)'],
        ['Working drawings (GFC)', 'Included'],
        ['Structural drawings', 'Included, as per IS 456 and IS 1893'],
        ['MEP drawings', 'Included'],
        ['VR / AR walkthrough', 'Included']
      ]],
      ['Structure', [
        ['Steel', 'TATA Steel or equivalent, Fe 500D'],
        ['Cement', 'Birla / UltraTech or equivalent, 43 or 53 grade'],
        ['Aggregates', '20 mm and 40 mm machine-crushed'],
        ['Blocks', 'Hydraulic pressed blocks, 6" and 4" (Apco / AVS or equivalent)'],
        ['RCC mix', 'M25 design mix'],
        ['Ceiling height', "11'0\" floor to floor"],
        ['Soil test', 'Included']
      ]],
      ['Kitchen', [
        ['Countertop', 'Quartz up to ₹500/sq ft'],
        ['Wall tiles above counter', 'Up to ₹100/sq ft, 2 ft height'],
        ['Kitchen sink', 'Stainless steel or granite-finish up to ₹9,000'],
        ['Sink faucet', 'Up to ₹4,000'],
        ['Faucets & accessories', 'Kohler or equivalent']
      ]],
      ['Bathroom', [
        ['Sanitaryware & CP fittings', 'Up to ₹40,000 per bathroom (commode, mixer, health faucet, soap dish, towel rail)'],
        ['Wall tiles', 'Up to ₹80/sq ft, full height'],
        ['Bathroom door', 'Waterproof flush door up to ₹12,000'],
        ['Glass partition', 'Master bathroom up to ₹15,000']
      ]],
      ['Plumbing & Water', [
        ['CPVC pipes', 'Ashirwad / Supreme or equivalent'],
        ['Overhead tank', 'Sintex triple-layer, 2,000 litres'],
        ['Underground sump', '10,000 litres, 6" solid block'],
        ['Geyser / solar provision', 'Included'],
        ['Rainwater harvesting', 'Included']
      ]],
      ['Doors & Windows', [
        ['Main door', 'Teak frame and shutter up to ₹55,000 with fittings'],
        ['Internal doors', 'Sal wood frame with 30 mm flush shutter up to ₹14,000'],
        ['Pooja room door', 'Teak frame and shutter up to ₹40,000'],
        ['Windows', 'UPVC with glass and mesh up to ₹750/sq ft'],
        ['Window grills', 'MS with enamel paint up to ₹150/sq ft'],
        ['Window opening', '12% of package built-up area']
      ]],
      ['Painting', [
        ['Interior', 'Birla putty + Apcolite Premium emulsion, 2 coats'],
        ['Exterior', 'Asian primer + Apex Ultima emulsion'],
        ['Ceiling', '2 coats emulsion']
      ]],
      ['Flooring', [
        ['Living & dining', 'Premium vitrified tiles or granite up to ₹140/sq ft'],
        ['Rooms & kitchen', 'Premium vitrified tiles or granite up to ₹130/sq ft'],
        ['Balcony & open areas', 'Anti-skid tiles up to ₹80/sq ft'],
        ['Staircase', 'Polished granite up to ₹120/sq ft'],
        ['Bathroom', 'Anti-skid tiles up to ₹90/sq ft'],
        ['Parking', 'Parking tiles up to ₹80/sq ft'],
        ['Pooja room wall tiles', 'Up to ₹80/sq ft, 7\'0" height']
      ]],
      ['Electrical', [
        ['Wires', 'Fire-retardant, Havells or equivalent'],
        ['Switches & sockets', 'GM Modular / Legrand or equivalent'],
        ['Distribution board', 'ISI-marked MCBs'],
        ['Light & fan points', 'As per the approved electrical layout'],
        ['CCTV / UPS / EV wiring', 'Provision included']
      ]],
      ['Elevation & Extras', [
        ['Elevation work', '1% of project value'],
        ['Internal lofts', '50 sq ft at ₹350/sq ft'],
        ['Staircase & balcony railings', 'SS railings with glass up to ₹450/sq ft'],
        ['Anti-termite treatment', 'Included'],
        ['Home automation', '10 switches per 1,000 sq ft + video door phone up to ₹15,000'],
        ['Digital lock & wireless CCTV', 'Up to ₹20,000 for the whole house'],
        ['Design revisions', 'Unlimited']
      ]]
    ]
  }
];

// Flatten a package plan into database rows for package_specs.
function specRows(plan) {
  const rows = [];
  plan.groups.forEach(([groupName, items]) => {
    items.forEach(([label, content]) => {
      rows.push({ group_name: groupName, label, content, sort_order: rows.length });
    });
  });
  return rows;
}

// Group flat package_specs rows back into [{ name, items: [...] }] for the view.
// Rows without a group land in a trailing "Specifications" section.
function groupSpecs(specs) {
  const groups = [];
  const index = new Map();

  (specs || []).forEach((spec) => {
    const name = (spec.group_name || '').trim() || 'Specifications';
    if (!index.has(name)) {
      index.set(name, { name, items: [] });
      groups.push(index.get(name));
    }
    index.get(name).items.push({ label: spec.label, content: spec.content });
  });

  return groups;
}

module.exports = { PACKAGE_PLANS, specRows, groupSpecs };
