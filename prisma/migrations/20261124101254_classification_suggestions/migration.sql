-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "suggestedClassification" "Classification",
ADD COLUMN     "suggestionReasons" JSONB;
