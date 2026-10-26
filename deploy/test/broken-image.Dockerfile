ARG BASE
FROM ${BASE}
CMD ["node", "-e", "console.error('deliberately broken build for the rollback test'); process.exit(1)"]
