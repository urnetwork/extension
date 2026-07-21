import * as React from "react";
import { createComponent } from "@lit/react";
import {
	Input as UrInputElement,
	INPUT_TYPES,
	type InputType,
} from "../../components/input/input.js";

export const Input = createComponent({
	tagName: "ur-input",
	elementClass: UrInputElement,
	react: React,
	events: {
		onInput: "ur-input",
		onChange: "ur-change",
	},
});

// Custom event detail type
export interface InputChangeDetail {
	value: string;
}

export interface InputProps {
	value?: string;
	placeholder?: string;
	type?: InputType;
	disabled?: boolean;
	readonly?: boolean;
	loading?: boolean;
	invalid?: boolean;
	name?: string;
	label?: string;
	hint?: string;
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	onInput?: (e: CustomEvent<InputChangeDetail>) => void;
	onChange?: (e: CustomEvent<InputChangeDetail>) => void;
	className?: string;
	style?: React.CSSProperties;
}

export const UrInput = React.forwardRef<UrInputElement, InputProps>(
	(props, ref) => {
		const { onInput, onChange, ...rest } = props;
		return (
			<Input
				ref={ref}
				{...rest}
				/* Cast handlers to satisfy @lit/react's expected (e: Event) => void signature.
          This is type-safe in practice because we mapped the events to 'ur-input'/'ur-change'
          which we know dispatch CustomEvents with the correct detail. */
				onInput={onInput as unknown as (e: Event) => void}
				onChange={onChange as unknown as (e: Event) => void}
			/>
		);
	},
);

UrInput.displayName = "UrInput";

export { UrInputElement, INPUT_TYPES, type InputType };
export default UrInput;
