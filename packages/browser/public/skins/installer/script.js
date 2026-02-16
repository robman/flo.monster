// CTA button triggers credentials overlay
const ctaButtons = shadowRoot.querySelectorAll('[data-cta="credentials"]');
ctaButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    container.container.dispatchEvent(new CustomEvent('outer-skin-cta', {
      bubbles: true,
      detail: { action: 'credentials' }
    }));
  });
});
