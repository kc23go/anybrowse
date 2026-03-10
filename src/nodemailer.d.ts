declare module 'nodemailer' {
  export function createTransport(options: any): any;
  export default { createTransport };
}
