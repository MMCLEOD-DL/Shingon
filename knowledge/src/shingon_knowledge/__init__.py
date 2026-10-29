"""Shingon knowledge service (K2 skeleton): permission-filtered, versioned, cited document retrieval.

See conductor/docs/knowledge-base/ for the research, the retrieval contract and the migration plan.
"""
from .parsers import ImportProblem, find_secret, parse
from .service import Credential, KnowledgeService, NotFound, ScopeError

__all__ = ['Credential', 'ImportProblem', 'KnowledgeService', 'NotFound', 'ScopeError', 'find_secret', 'parse']
