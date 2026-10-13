document.addEventListener('DOMContentLoaded', () => {
  const menuToggle = document.querySelector('.menu-toggle');
  const mobileNav = document.querySelector('.mobile-nav');
  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', () => {
      const expanded = mobileNav.style.display === 'flex';
      mobileNav.style.display = expanded ? 'none' : 'flex';
    });
  }

  const faqButtons = document.querySelectorAll('.faq-item button');
  faqButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const parent = button.closest('.faq-item');
      parent.classList.toggle('active');
    });
  });

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
        const notice = form.querySelector('.form-notice') || document.createElement('div');
        notice.className = `notice form-notice ${response.ok && result.success ? 'success' : 'error'}`;
        notice.setAttribute('role', 'status');
        notice.textContent = result.message || result.error || 'We could not send your enquiry. Please try again.';
        if (!notice.isConnected) form.appendChild(notice);

        if (response.ok && result.success) form.reset();
      } catch (error) {
        const notice = form.querySelector('.form-notice') || document.createElement('div');
        notice.className = 'notice form-notice error';
        notice.setAttribute('role', 'status');
        notice.textContent = 'We could not connect to send your enquiry. Please try again.';
        if (!notice.isConnected) form.appendChild(notice);
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  });
});
