import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import './ui.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}
export function Input({ label, error, id, ...rest }: InputProps): JSX.Element {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="mc-field">
      {label && (
        <label className="mc-field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <input
        id={inputId}
        className="mc-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-err` : undefined}
        {...rest}
      />
      {error && (
        <span className="mc-field__error" id={`${inputId}-err`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  children: ReactNode;
}
export function Select({ label, error, id, children, ...rest }: SelectProps): JSX.Element {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className="mc-field">
      {label && (
        <label className="mc-field__label" htmlFor={selectId}>
          {label}
        </label>
      )}
      <select id={selectId} className="mc-select" aria-invalid={error ? true : undefined} {...rest}>
        {children}
      </select>
      {error && (
        <span className="mc-field__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
