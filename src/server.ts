import { buildServer } from "./app.js";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";

buildServer()
  .listen({ port: config.PORT, host: "0.0.0.0" })
  .catch((e) => {
    logger.fatal(e);
    process.exit(1);
  });
