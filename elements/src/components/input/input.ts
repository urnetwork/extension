import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { inputStyles } from "./input.styles";
import "../icons/icon-warning";
import "../icons/icon-spinner";

export const INPUT_TYPES = [
	"text",
	"email",
	"password",
	"search",
	"tel",
	"url",
	"number",
] as const;
export type InputType = (typeof INPUT_TYPES)[number];

@customElement("ur-input")
export class Input extends LitElement {
	static styles = inputStyles;

	@property({ type: String }) value = "";
	@property({ type: String }) placeholder = "";
	@property({ type: String }) type: InputType = "text";
	@property({ type: Boolean, reflect: true }) disabled = false;
	@property({ type: Boolean, reflect: true }) readonly = false;
	@property({ type: Boolean, reflect: true }) loading = false;
	@property({ type: String }) name = "";
	@property({ type: String }) label = "";
	@property({ type: String }) hint = "";
	@property({ type: Boolean, reflect: true }) invalid = false;
	@property({ type: Boolean, reflect: true }) required = false;
	@property({ type: Number }) minLength?: number;
	@property({ type: Number }) maxLength?: number;

	// Event handler for input changes
	private handleInput(e: InputEvent) {
		const target = e.target as HTMLInputElement;
		this.value = target.value;

		// Dispatch a custom event that bubbles up
		this.dispatchEvent(
			new CustomEvent("ur-input", {
				detail: { value: target.value },
				bubbles: true,
				composed: true,
			}),
		);
	}

	// Event handler for native change event
	private handleChange(e: Event) {
		const target = e.target as HTMLInputElement;

		this.dispatchEvent(
			new CustomEvent("ur-change", {
				detail: { value: target.value },
				bubbles: true,
				composed: true,
			}),
		);
	}

	private handleKeyDown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			const form = this.closest("form");
			if (form) {
				e.preventDefault();
				// Defer form submission to next tick to allow React state updates to complete
				setTimeout(() => {
					form.requestSubmit();
				}, 10);
			}
		}
	}

	render() {
		return html`
			<div class="input-wrapper">
				${this.label
					? html`<label class="input-label ${this.invalid ? "error" : ""}">
							${this.label}
							${this.required ? html`<span class="required">*</span>` : ""}
						</label>`
					: ""}

				<div class="input-container">
					<input
						type=${this.type}
						.value=${this.value}
						placeholder=${this.placeholder}
						?disabled=${this.disabled || this.loading}
						?readonly=${this.readonly}
						?required=${this.required}
						minlength=${this.minLength ?? ""}
						maxlength=${this.maxLength ?? ""}
						name=${this.name}
						class="input-field ${this.invalid ? "error" : ""}"
						@input=${this.handleInput}
						@change=${this.handleChange}
						@keydown=${this.handleKeyDown}
					/>

					${this.loading
						? html`<ur-icon-spinner class="input-spinner" size="0.8"></ur-spinner>`
						: ""}
					${this.invalid && !this.loading
						? html`<ur-icon-warning
								class="input-error-icon"
								style="color: var(--ur-color-coral)"
							></ur-icon-warning>`
						: ""}
				</div>

				${this.hint
					? html`<span class="hint ${this.invalid ? "error" : ""}"
							>${this.hint}</span
						>`
					: ""}
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"ur-input": Input;
	}
}
