# Image Node.js officielle, version 24 (celle utilisee et testee en developpement).
# NE PAS repasser en node:22 : node:sqlite n'y est disponible sans drapeau
# qu'a partir de 22.13, et le tag "22" est flottant. En cas de downgrade,
# le serveur refuse de demarrer ("Cannot find module 'node:sqlite'").
FROM node:24-alpine

# Ne jamais executer le serveur en root
RUN addgroup -S compta && adduser -S compta -G compta

WORKDIR /app

# Aucune dependance a installer : le projet n'utilise que node:crypto et node:sqlite
COPY --chown=compta:compta package.json ./
COPY --chown=compta:compta server.js db.js auth.js ./
COPY --chown=compta:compta public ./public

# Dossier de la base, monte en volume persistant
RUN mkdir -p /data && chown compta:compta /data
VOLUME ["/data"]

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    COMPA_DB=/data/compta.db

USER compta
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
