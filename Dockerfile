# Image Node.js 24 (version utilisee et testee en developpement).
FROM node:24-alpine

# Ne jamais executer le serveur en root
RUN addgroup -S compta && adduser -S compta -G compta

WORKDIR /app

# Les dependances sont installees dans une couche dediee : le cache Docker est
# invalide uniquement quand package.json / package-lock.json changent.
# `pg` est necessaire pour Neon, `npm ci --omit=dev` garantit que la version
# exacte du lockfile est utilisee en production.
COPY --chown=compta:compta package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=compta:compta server.js db.js auth.js seed.js ./
COPY --chown=compta:compta public ./public

# La base est hebergee par PostgreSQL (Neon) : aucun volume local n'est requis.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

USER compta
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
