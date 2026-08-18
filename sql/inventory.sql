-- Wasteland Web — esquema do inventário espacial (MySQL 8.0+).
--
-- Mapeia direto nas classes de `src/inventory/types.ts`:
--   ItemBase       -> items_base
--   ContainerDef   -> containers
--   ItemInstance   -> item_instances
--   ItemAttachment -> item_attachments
--
-- Três decisões que valem a explicação:
--
-- 1. `items_base` é a definição ("o que é um fuzil") e `item_instances` é o
--    objeto ("*este* fuzil"). Juntar as duas parece econômico enquanto tudo
--    está em memória, mas deixa a chave estrangeira sem nada estável para
--    apontar e torna o save impossível.
--
-- 2. Um item está **ou** numa célula de grid **ou** num slot de equipamento,
--    nunca nos dois. O CHECK impede a linha inconsistente na origem, em vez de
--    deixar um item equipado colidindo com quem ocupa o canto do grid.
--
-- 3. `containers.parent_instance_id` é o que permite aninhar: a mochila é uma
--    instância dentro de uma caixa e ao mesmo tempo o contêiner que guarda os
--    carregadores. ON DELETE CASCADE faz o conteúdo sumir junto com ela.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- Definições estáticas. Uma linha por tipo de item do jogo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items_base (
  id                VARCHAR(64)   NOT NULL,
  name              VARCHAR(128)  NOT NULL,
  -- Dimensão no grid, sem rotação. A rotação vive na instância.
  width             TINYINT UNSIGNED NOT NULL DEFAULT 1,
  height            TINYINT UNSIGNED NOT NULL DEFAULT 1,
  weight_kg         DECIMAL(7,3)  NOT NULL DEFAULT 0.000,
  value             INT UNSIGNED  NOT NULL DEFAULT 0,
  -- Tags separadas por vírgula; a filtragem pesada acontece em memória, e o
  -- índice abaixo cobre a busca por prefixo que a loja e os filtros usam.
  tags              VARCHAR(255)  NOT NULL DEFAULT '',
  equip_slots       VARCHAR(255)  NULL,
  -- Preenchidos quando o próprio item é contêiner.
  container_width   TINYINT UNSIGNED NULL,
  container_height  TINYINT UNSIGNED NULL,
  container_accepts VARCHAR(255)  NULL,
  capacity          SMALLINT UNSIGNED NULL,
  calibre           VARCHAR(32)   NULL,
  max_durability    SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  model             VARCHAR(128)  NULL,
  PRIMARY KEY (id),
  KEY idx_items_base_tags (tags(64)),
  KEY idx_items_base_calibre (calibre),
  CONSTRAINT chk_items_base_size CHECK (width BETWEEN 1 AND 16 AND height BETWEEN 1 AND 16)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Todo grid do jogo: mochila do jogador, caixa no mapa, corpo, chão.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS containers (
  id                  CHAR(36)     NOT NULL,
  kind                ENUM('player','equipment','stash','crate','corpse','ground','nested') NOT NULL,
  name                VARCHAR(128) NOT NULL DEFAULT '',
  width               TINYINT UNSIGNED NOT NULL,
  height              TINYINT UNSIGNED NOT NULL,
  -- Dono, para o stash. NULL nos contêineres do mundo.
  owner_id            CHAR(36)     NULL,
  accepts             VARCHAR(255) NULL,
  -- Posição no mapa, para caixa, corpo e pilha no chão.
  pos_x               FLOAT        NULL,
  pos_y               FLOAT        NULL,
  pos_z               FLOAT        NULL,
  -- Contêiner aninhado: a instância que o criou.
  parent_instance_id  CHAR(36)     NULL,
  -- Segundos de busca antes de revelar o conteúdo. 0 = visível na hora.
  search_seconds      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- A consulta mais quente do jogo: "todos os contêineres deste jogador".
  KEY idx_containers_owner (owner_id, kind),
  KEY idx_containers_parent (parent_instance_id),
  -- Varredura por proximidade para loot no chão e corpos.
  KEY idx_containers_position (pos_x, pos_z),
  CONSTRAINT chk_containers_size CHECK (width BETWEEN 1 AND 32 AND height BETWEEN 1 AND 32)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Cada objeto que existe no jogo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_instances (
  uuid            CHAR(36)     NOT NULL,
  base_item_id    VARCHAR(64)  NOT NULL,
  container_id    CHAR(36)     NULL,
  position_x      TINYINT UNSIGNED NULL,
  position_y      TINYINT UNSIGNED NULL,
  rotation        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  equipped_slot   VARCHAR(32)  NULL,
  -- Munição no carregador, ou unidades na pilha.
  quantity        SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  durability      SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  extra_json      JSON         NULL,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (uuid),
  -- Carregar um inventário é sempre "tudo deste contêiner".
  KEY idx_instances_container (container_id, position_y, position_x),
  KEY idx_instances_base (base_item_id),
  CONSTRAINT fk_instances_base
    FOREIGN KEY (base_item_id) REFERENCES items_base (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Destruir um contêiner leva junto o que havia dentro.
  CONSTRAINT fk_instances_container
    FOREIGN KEY (container_id) REFERENCES containers (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_instances_rotation CHECK (rotation IN (0, 90)),
  -- Ou está numa célula, ou está equipado. Nunca os dois, nunca nenhum dos
  -- dois enquanto pertence a um contêiner.
  CONSTRAINT chk_instances_placement CHECK (
    (equipped_slot IS NOT NULL AND position_x IS NULL AND position_y IS NULL)
    OR (equipped_slot IS NULL AND position_x IS NOT NULL AND position_y IS NOT NULL)
    OR (container_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Adicionada depois das duas tabelas porque a referência é circular:
-- um contêiner aninhado aponta para a instância que o criou.
ALTER TABLE containers
  ADD CONSTRAINT fk_containers_parent_instance
  FOREIGN KEY (parent_instance_id) REFERENCES item_instances (uuid)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Peças acopladas: mira no fuzil, carregador na arma.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_attachments (
  parent_instance_id CHAR(36)    NOT NULL,
  slot_type          VARCHAR(32) NOT NULL,
  child_instance_id  CHAR(36)    NOT NULL,
  -- Um slot por peça: não existe duas miras no mesmo trilho.
  PRIMARY KEY (parent_instance_id, slot_type),
  -- E uma peça não pode estar em duas armas ao mesmo tempo.
  UNIQUE KEY uq_attachments_child (child_instance_id),
  KEY idx_attachments_parent (parent_instance_id),
  CONSTRAINT fk_attachments_parent
    FOREIGN KEY (parent_instance_id) REFERENCES item_instances (uuid)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_attachments_child
    FOREIGN KEY (child_instance_id) REFERENCES item_instances (uuid)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Consultas que o servidor faz com frequência, deixadas prontas.
-- ---------------------------------------------------------------------------

-- Inventário inteiro de um contêiner, na ordem em que o grid é desenhado.
-- SELECT i.*, b.width, b.height, b.tags
--   FROM item_instances i
--   JOIN items_base b ON b.id = i.base_item_id
--  WHERE i.container_id = ?
--  ORDER BY i.position_y, i.position_x;

-- Tudo que um jogador possui, incluindo contêineres aninhados.
-- WITH RECURSIVE owned AS (
--   SELECT id FROM containers WHERE owner_id = ?
--   UNION ALL
--   SELECT c.id FROM containers c
--     JOIN item_instances i ON i.uuid = c.parent_instance_id
--     JOIN owned o ON o.id = i.container_id
-- )
-- SELECT * FROM item_instances WHERE container_id IN (SELECT id FROM owned);

-- Loot por perto: corpos e caixas num raio, para a interação de proximidade.
-- SELECT * FROM containers
--  WHERE kind IN ('corpse','ground','crate')
--    AND pos_x BETWEEN ? - ? AND ? + ?
--    AND pos_z BETWEEN ? - ? AND ? + ?;
