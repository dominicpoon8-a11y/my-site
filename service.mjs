import node from "@prisma/composer/node";
import { compute } from "@prisma/composer-prisma-cloud";
import { dataContract, postgres } from "@prisma/composer-prisma-cloud/orm";
import { type } from "arktype";
import { secretString } from "@prisma/composer/arktype";
import contractJson from "./prisma/contract.json" with { type: "json" };

const dbContract = dataContract(contractJson);

export default compute({
  name: "web",
  deps: { db: postgres(dbContract) },
  input: type({
    sessionSecret: secretString(),
  }),
  build: node({
    module: import.meta.url,
    dir: "dist",
    entry: "server.mjs",
    dependencies: "external",
  }),
});
