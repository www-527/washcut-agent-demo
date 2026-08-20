import type {SVGProps} from 'react';

const Icon = ({children, ...props}: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>
);

export const UploadIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></Icon>;
export const AttachmentIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="m20.5 11.5-7.8 7.8a5.2 5.2 0 0 1-7.4-7.4l8.3-8.3a3.7 3.7 0 0 1 5.2 5.2l-8.4 8.4a2.1 2.1 0 1 1-3-3l7.6-7.6"/></Icon>;
export const SparkIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M12 3l1.2 4.1L17 9l-3.8 1.9L12 15l-1.2-4.1L7 9l3.8-1.9L12 3Z"/><path d="M18.5 14.5l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z"/></Icon>;
export const ShieldIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M12 3 5 6v5c0 4.8 2.7 8 7 10 4.3-2 7-5.2 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></Icon>;
export const CheckIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="m5 12 4 4L19 6"/></Icon>;
export const TrashIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7"/></Icon>;
export const PlayIcon = (props: SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}><path d="M8 5.5v13l10-6.5-10-6.5Z"/></svg>;
export const ChevronIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="m9 18 6-6-6-6"/></Icon>;
export const BracketsIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3m13 5h3a2 2 0 0 0 2-2v-3"/><path d="m9 9-3 3 3 3m6-6 3 3-3 3"/></Icon>;
