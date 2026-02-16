/**
 * Shared DOM creation helpers for UI components.
 *
 * These helpers extract repeated patterns found across settings sections,
 * dialogs, and panels to reduce boilerplate and improve consistency.
 */

// ---------------------------------------------------------------------------
// Form field creation
// ---------------------------------------------------------------------------

export interface FormFieldOptions {
  /** Label text */
  label: string;
  /** Input type: 'input', 'select', or 'textarea' */
  type: 'input' | 'select' | 'textarea';
  /** Additional CSS class(es) for the input/select/textarea element */
  className?: string;
  /** Additional CSS class(es) for the wrapper div */
  wrapperClassName?: string;
  /** Input type attribute (for type='input', e.g. 'text', 'number', 'url', 'password') */
  inputType?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Initial value */
  value?: string;
  /** Number of rows (for textarea) */
  rows?: number;
  /** Step attribute (for number inputs) */
  step?: string;
  /** Hint text shown below the input */
  hint?: string;
}

export interface FormFieldResult<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> {
  /** The wrapper div.form-field element */
  field: HTMLDivElement;
  /** The label element */
  label: HTMLLabelElement;
  /** The input/select/textarea element */
  input: T;
}

/**
 * Create a form field with label and input/select/textarea.
 *
 * Produces the standard structure:
 * ```html
 * <div class="form-field">
 *   <label class="form-field__label">Label</label>
 *   <input class="form-field__input" />
 *   <span class="form-field__hint">hint</span>   <!-- optional -->
 * </div>
 * ```
 */
export function createFormField(opts: FormFieldOptions & { type: 'input' }): FormFieldResult<HTMLInputElement>;
export function createFormField(opts: FormFieldOptions & { type: 'select' }): FormFieldResult<HTMLSelectElement>;
export function createFormField(opts: FormFieldOptions & { type: 'textarea' }): FormFieldResult<HTMLTextAreaElement>;
export function createFormField(opts: FormFieldOptions): FormFieldResult<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
export function createFormField(opts: FormFieldOptions): FormFieldResult<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> {
  const field = document.createElement('div');
  field.className = opts.wrapperClassName
    ? `form-field ${opts.wrapperClassName}`
    : 'form-field';

  const label = document.createElement('label');
  label.className = 'form-field__label';
  label.textContent = opts.label;
  field.appendChild(label);

  let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

  if (opts.type === 'select') {
    const sel = document.createElement('select');
    sel.className = opts.className
      ? `form-field__select ${opts.className}`
      : 'form-field__select';
    input = sel;
  } else if (opts.type === 'textarea') {
    const ta = document.createElement('textarea');
    ta.className = opts.className
      ? `form-field__textarea ${opts.className}`
      : 'form-field__textarea';
    if (opts.rows !== undefined) ta.rows = opts.rows;
    if (opts.placeholder) ta.placeholder = opts.placeholder;
    if (opts.value !== undefined) ta.value = opts.value;
    input = ta;
  } else {
    const inp = document.createElement('input');
    inp.className = opts.className
      ? `form-field__input ${opts.className}`
      : 'form-field__input';
    inp.type = opts.inputType || 'text';
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    if (opts.value !== undefined) inp.value = opts.value;
    if (opts.step) inp.step = opts.step;
    input = inp;
  }

  field.appendChild(input);

  if (opts.hint) {
    const hint = document.createElement('span');
    hint.className = 'form-field__hint';
    hint.textContent = opts.hint;
    field.appendChild(hint);
  }

  return { field, label, input };
}

// ---------------------------------------------------------------------------
// Select population
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Populate a <select> element with options.
 *
 * Clears existing options first, then appends new ones.
 * If `selectedValue` matches an option's value, that option is selected.
 */
export function populateSelect(
  select: HTMLSelectElement,
  items: SelectOption[],
  selectedValue?: string,
): void {
  select.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    if (selectedValue !== undefined && item.value === selectedValue) {
      option.selected = true;
    }
    select.appendChild(option);
  }
}

// ---------------------------------------------------------------------------
// Checkbox with label
// ---------------------------------------------------------------------------

/**
 * Create a labeled checkbox element.
 *
 * Produces:
 * ```html
 * <label class="tool-checkbox">
 *   <input type="checkbox" />
 *   <span>Label text</span>
 *   <span class="tool-checkbox__badge">badge</span>  <!-- optional -->
 * </label>
 * ```
 */
export function createCheckboxLabel(
  label: string,
  checked: boolean,
  onChange?: (checked: boolean) => void,
  badge?: string,
): { wrapper: HTMLLabelElement; checkbox: HTMLInputElement } {
  const wrapper = document.createElement('label');
  wrapper.className = 'tool-checkbox';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = checked;

  const span = document.createElement('span');
  span.textContent = label;

  wrapper.appendChild(checkbox);
  wrapper.appendChild(span);

  if (badge) {
    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'tool-checkbox__badge';
    badgeSpan.textContent = badge;
    wrapper.appendChild(badgeSpan);
  }

  if (onChange) {
    checkbox.addEventListener('change', () => {
      onChange(checkbox.checked);
    });
  }

  return { wrapper, checkbox };
}

// ---------------------------------------------------------------------------
// Empty state message
// ---------------------------------------------------------------------------

/**
 * Create an empty-state paragraph element.
 *
 * ```html
 * <p class="className">message</p>
 * ```
 */
export function createEmptyState(message: string, className?: string): HTMLParagraphElement {
  const el = document.createElement('p');
  el.className = className || 'empty-state';
  el.textContent = message;
  return el;
}

// ---------------------------------------------------------------------------
// Loading indicator
// ---------------------------------------------------------------------------

/**
 * Create a loading indicator element.
 *
 * ```html
 * <div class="className">message</div>
 * ```
 */
export function createLoadingIndicator(message?: string, className?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className || 'loading-indicator';
  el.textContent = message || 'Loading...';
  return el;
}
