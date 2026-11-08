import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

// Extend Express Request interface to include typed validatedQuery
declare global {
  namespace Express {
    interface Request {
      validatedQuery?: Record<string, unknown>;
    }
  }
}

interface RequestValidationSchema {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

/**
 * Express middleware to validate request body, params, and query using Zod.
 * Stores validated and transformed query data on req.validatedQuery and res.locals.validatedQuery
 * to avoid illegal assignment to Express 5's getter-only req.query property.
 */
export function validateRequest(schemas: RequestValidationSchema) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (schemas.body) {
        req.body = await schemas.body.parseAsync(req.body);
      }
      if (schemas.params) {
        req.params = (await schemas.params.parseAsync(req.params)) as Record<string, string>;
      }
      if (schemas.query) {
        const parsedQuery = (await schemas.query.parseAsync(req.query)) as Record<string, unknown>;
        req.validatedQuery = parsedQuery;
        res.locals.validatedQuery = parsedQuery;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: "Validation failed",
          details: error.issues.map((err) => ({
            field: err.path.join("."),
            message: err.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
}
