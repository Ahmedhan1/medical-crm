/**
 * MEDCORE design-system barrel. Domain teams import shared UI from
 * `@/components/ui` only — never re-implement primitives. Extend by proposing a
 * new primitive to Agent 1 (platform), not by forking one into a domain folder.
 */
export { Button, Badge, Alert, Spinner, Skeleton, Card } from './primitives.js';
export type { ButtonProps, BadgeTone, AlertTone } from './primitives.js';
export { Input, Select } from './fields.js';
export type { InputProps, SelectProps } from './fields.js';
export { Dialog, Drawer } from './overlays.js';
export { Table, Tabs, EmptyState, ErrorState, Pagination } from './data.js';
export type { Column, TabItem } from './data.js';
export { ToastProvider, useToast } from './toast.js';
export type { ToastTone } from './toast.js';
