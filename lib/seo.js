'use strict';

// Search-engine metadata for the public pages: the copy that appears in a
// results listing (title/description/keywords) plus the structured data
// (schema.org JSON-LD) that lets Google show rich results such as the
// business card, FAQ dropdowns, breadcrumb trails and property listings.

const DEFAULT_SITE_NAME = 'Shivanda Properties & Construction';
const DEFAULT_KEYWORDS =
  'real estate Bengaluru, property for sale Bangalore, plots in Bengaluru, ' +
  'apartments in Whitefield, villas in Nelamangala, turnkey construction Bangalore, ' +
  'house construction cost per sqft Bengaluru, construction packages Nelamangala, ' +
  'buy plot near Bengaluru, property dealer Nelamangala, Shivanda Properties';

// Keyword strings tuned to what people actually search for in each area of the
// site. They are a ranking hint, not a stuffing list: each page gets only the
// terms that describe that page.
const PAGE_SEO = {
  home: {
    description:
      'Shivanda Properties & Construction helps you buy plots, villas and apartments in Bengaluru and build turnkey homes from Rs 1,999/sq.ft. RERA-aware guidance, transparent pricing and 12+ years of local experience.',
    keywords:
      'Shivanda Properties, real estate Bengaluru, buy property Bangalore, construction company Nelamangala, turnkey house construction Bengaluru, property dealer Vijaya Vittal Nagar'
  },
  properties: {
    description:
      'Browse verified plots, villas, apartments and independent houses for sale across Bengaluru. Filter by locality, budget and property type, with photos, RERA details and direct enquiry.',
    keywords:
      'property for sale Bengaluru, plots for sale Bangalore, villas Whitefield, apartments Nelamangala, independent house Bengaluru, buy land near Bangalore'
  },
  construction: {
    description:
      'Turnkey construction packages from Rs 1,999 to Rs 2,399 per sq.ft. Compare Elegance, Premium, Elite and Luxury specifications - structure, fittings, electrical and finishing - and estimate your build cost instantly.',
    keywords:
      'construction packages Bangalore, house construction cost per sqft Nelamangala, turnkey construction Bengaluru, G+1 construction cost Bangalore, construction rate per sqft 2026'
  },
  contact: {
    description:
      'Contact Shivanda Properties & Construction in Nelamangala, Bengaluru. Call, WhatsApp or send an enquiry about buying property or starting a construction project.',
    keywords:
      'contact Shivanda Properties, construction enquiry Bengaluru, property enquiry Nelamangala, Shivanda Properties phone number address'
  }
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON-LD is emitted inside a <script> tag, where a literal "</" would end the
// block early. Unicode-escaping "<" keeps the payload inert.
function jsonLdScript(data) {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

// Resolve a site-relative asset ("/images/logo.webp") to an absolute URL, so
// social cards and Google can fetch it.
function absoluteUrl(origin, value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const base = String(origin || '').replace(/\/+$/, '');
  return `${base}${value.startsWith('/') ? '' : '/'}${value}`;
}

function siteName(settings = {}) {
  return settings.company_name || DEFAULT_SITE_NAME;
}

// Merge the defaults for a page with whatever the route supplied, so a route
// that forgets to pass SEO still renders complete tags.
function resolvePageSeo(page = {}, key = '') {
  const defaults = PAGE_SEO[key] || {};
  return {
    description: page.description || defaults.description || '',
    keywords: page.keywords || defaults.keywords || DEFAULT_KEYWORDS,
    ogTitle: page.ogTitle || page.title || '',
    ogType: page.ogType || 'website',
    ogImage: page.ogImage || '/images/logo.webp'
  };
}

// schema.org LocalBusiness/RealEstateAgent node describing the company itself.
function organizationJsonLd({ origin = '', settings = {} } = {}) {
  const name = siteName(settings);
  const phone = settings.phone || '+91 96860 01144';
  const email = settings.email || 'Shivandapropertiesandconstruct@gmail.com';
  const address = settings.address || 'Bengaluru, Karnataka';

  return {
    '@context': 'https://schema.org',
    '@type': ['RealEstateAgent', 'LocalBusiness'],
    '@id': `${origin}/#organization`,
    name,
    url: `${origin}/`,
    logo: absoluteUrl(origin, '/images/logo.png'),
    image: absoluteUrl(origin, '/images/logo.webp'),
    telephone: phone,
    email,
    priceRange: '₹₹',
    address: {
      '@type': 'PostalAddress',
      streetAddress: address,
      addressLocality: 'Bengaluru',
      addressRegion: 'Karnataka',
      addressCountry: 'IN'
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: 13.0988,
      longitude: 77.4833
    },
    areaServed: {
      '@type': 'City',
      name: 'Bengaluru'
    },
    openingHoursSpecification: {
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      opens: '09:30',
      closes: '19:00'
    }
  };
}

// WebSite node: lets Google associate the site with the business and shows the
// search box in some result layouts.
function websiteJsonLd({ origin = '', settings = {} } = {}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${origin}/#website`,
    url: `${origin}/`,
    name: siteName(settings),
    publisher: { '@id': `${origin}/#organization` },
    inLanguage: 'en-IN'
  };
}

// ItemList of the packages offered, so prices show up in search results.
function servicesJsonLd({ origin = '', settings = {}, packages = [] } = {}) {
  const items = packages.map((pkg, index) => ({
    '@type': 'Offer',
    position: index + 1,
    itemOffered: {
      '@type': 'Service',
      name: `${pkg.name} construction package`,
      serviceType: 'Turnkey house construction',
      areaServed: 'Bengaluru, Karnataka',
      provider: { '@id': `${origin}/#organization` },
      url: `${origin}/construction#packages`
    },
    price: pkg.rate,
    priceCurrency: 'INR',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: pkg.rate,
      priceCurrency: 'INR',
      unitText: 'square foot',
      unitCode: 'FTK'
    }
  }));

  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Turnkey construction packages',
    numberOfItems: items.length,
    itemListElement: items
  };
}

// A published property rendered as a RealEstateListing, which Google can show
// as a rich result with price and location.
function realEstateListingJsonLd({ origin = '', property = {}, coverImage = '' } = {}) {
  const price = Number(property.price || 0);
  const listing = {
    '@type': 'RealEstateListing',
    '@id': `${origin}/property/${property.slug}#listing`,
    url: `${origin}/property/${property.slug}`,
    name: property.title,
    description: property.description || property.title,
    datePosted: property.created_at || undefined,
    dateModified: property.updated_at || undefined,
    about: {
      '@type': property.type || 'Residence',
      name: property.title
    },
    offers: {
      '@type': 'Offer',
      price,
      priceCurrency: 'INR',
      availability: property.status === 'Sold' ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
      url: `${origin}/property/${property.slug}`
    }
  };

  if (coverImage) listing.image = [absoluteUrl(origin, coverImage)];
  if (property.locality) {
    listing.address = {
      '@type': 'PostalAddress',
      streetAddress: property.address || property.locality,
      addressLocality: property.locality,
      addressRegion: 'Karnataka',
      addressCountry: 'IN'
    };
  }
  if (property.rera_id) listing.subjectOf = { '@type': 'CreativeWork', identifier: property.rera_id };

  return listing;
}

// FAQ dropdown markup on the homepage becomes eligible for Google's FAQ
// rich result.
function faqJsonLd({ origin = '', faqs = [] } = {}) {
  const usable = faqs.filter((faq) => faq && faq.question && faq.answer);
  if (!usable.length) return null;

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${origin}/#faq`,
    mainEntity: usable.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer }
    }))
  };
}

// Breadcrumb trail shown under the page title in search results.
function breadcrumbJsonLd({ origin = '', items = [] } = {}) {
  const usable = items.filter((item) => item && item.name);
  if (usable.length < 2) return null;

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: usable.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url ? `${origin}${item.url}` : undefined
    }))
  };
}

module.exports = {
  DEFAULT_KEYWORDS,
  PAGE_SEO,
  escapeHtml,
  jsonLdScript,
  absoluteUrl,
  siteName,
  resolvePageSeo,
  organizationJsonLd,
  websiteJsonLd,
  servicesJsonLd,
  realEstateListingJsonLd,
  faqJsonLd,
  breadcrumbJsonLd
};
