import { define } from "../utils.ts";

export default define.page(function App({ Component }) {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>IPv4/IPv6 Equality Test</title>
      </head>
      <body>
        <Component />
      </body>
    </html>
  );
});
