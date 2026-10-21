document.addEventListener('DOMContentLoaded', () => {
  const menuToggle = document.querySelector('.menu-toggle');
  const mobileNav = document.querySelector('.mobile-nav');
  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', () => {
      const expanded = mobileNav.style.display === 'flex';
      mobileNav.style.display = expanded ? 'none' : 'flex';
    });
  }

  const siteHeader = document.querySelector('.site-header');
  if (siteHeader) {
    let lastScrollY = window.scrollY;
    window.addEventListener('scroll', () => {
      const currentY = Math.round(window.scrollY);
      if (currentY === lastScrollY) return;
      const scrollingDown = currentY > lastScrollY;
      lastScrollY = currentY;
      const menuOpen = Boolean(mobileNav && mobileNav.style.display === 'flex');
      if (menuOpen || currentY <= 160) {
        siteHeader.classList.remove('header-hidden');
      } else if (scrollingDown) {
        siteHeader.classList.add('header-hidden');
      } else {
        siteHeader.classList.remove('header-hidden');
      }
    }, { passive: true });
  }

  const faqButtons = document.querySelectorAll('.faq-item button');
  faqButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const parent = button.closest('.faq-item');
      parent.classList.toggle('active');
    });
  });

  function showFormNotice(form, { type, text, link, linkLabel }) {
    let notice = form.querySelector('.form-notice');
    if (!notice) {
      notice = document.createElement('div');
      form.appendChild(notice);
    }
    notice.className = `notice form-notice ${type}`;
    notice.setAttribute('role', 'status');
    notice.textContent = text;

    if (link) {
      notice.appendChild(document.createTextNode(' '));
      const anchor = document.createElement('a');
      anchor.href = link;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.className = 'whatsapp-link';
      anchor.textContent = linkLabel || 'Open WhatsApp';
      notice.appendChild(anchor);
    }
  }

  // Package estimate: area x each package rate, refreshed as the visitor types.
  const estimateList = document.getElementById('estimate-list');
  const areaInput = document.getElementById('area-input');
  if (estimateList && areaInput) {
    const sheets = Array.from(document.querySelectorAll('.package-sheet[data-rate]'));
    const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

    const renderEstimate = () => {
      const area = Math.max(0, Math.floor(Number(areaInput.value) || 0));
      estimateList.textContent = '';

      if (!area) {
        const hint = document.createElement('p');
        hint.className = 'muted-line';
        hint.textContent = 'Enter a built-up area to see the totals.';
        estimateList.appendChild(hint);
        return;
      }

      sheets.forEach((sheet) => {
        const rate = Number(sheet.dataset.rate) || 0;
        const row = document.createElement('div');
        row.className = 'estimate-row';

        const label = document.createElement('span');
        label.textContent = `${sheet.dataset.name} (₹${rate.toLocaleString('en-IN')}/sq ft)`;

        const total = document.createElement('strong');
        total.textContent = inr.format(area * rate);

        row.append(label, total);
        estimateList.appendChild(row);
      });
    };

    areaInput.addEventListener('input', renderEstimate);
    renderEstimate();
  }

  const forms = document.querySelectorAll('[data-enquiry-form]');
  forms.forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
      const submitButton = form.querySelector('[type="submit"]');
      if (submitButton) submitButton.disabled = true;

      try {
        const response = await fetch('/api/enquiry', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
          },
          body: JSON.stringify(payload)
        });

        const result = await response.json().catch(() => ({}));
        const succeeded = response.ok && result.success;

        if (succeeded) {
          showFormNotice(form, {
            type: 'success',
            text: result.message || 'Your enquiry has been sent. Our team will contact you shortly.',
            // When the business has WhatsApp alerts wired up the message already
            // reached them; otherwise let the visitor forward it in one tap.
            link: result.whatsappUrl,
            linkLabel: result.whatsappDelivered ? 'Chat on WhatsApp' : 'Forward it on WhatsApp'
          });
          form.reset();
        } else {
          showFormNotice(form, {
            type: 'error',
            text: result.error || 'We could not send your enquiry. Please try again.'
          });
        }
      } catch (error) {
        showFormNotice(form, {
          type: 'error',
          text: 'We could not connect to send your enquiry. Please try again.'
        });
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  });
});
