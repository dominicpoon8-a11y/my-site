import { module } from "@prisma/composer";
import { envSecret } from "@prisma/composer-prisma-cloud";
import { dataContract, postgres } from "@prisma/composer-prisma-cloud/orm";
import appService from "./service.mjs";
import contractJson from "./prisma/contract.json" with { type: "json" };

const dbContract = dataContract(contractJson);

export default module("tkpss-resource-library", ({ provision }) => {
  const db = provision(
    postgres({ name: "db", contract: dbContract, config: "./prisma.config.ts" }),
  );
  provision(appService, {
    deps: { db },
    input: {
      sessionSecret: envSecret("SESSION_SECRET"), // Signs session cookies.
    },
  });
});
